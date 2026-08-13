/**
 * Liquidation Guardian — orchestration loop.
 *
 * This is the "LLM decides, KeeperHub executes" half of the system. The always-on
 * watching is the event-driven watcher in server/ (see server/event-watcher.ts);
 * this process is what that watcher hands off to once a position is at risk.
 *
 * Flow:  read position → if HF < threshold → read exact token balances →
 *        ask the LLM which lever to pull → size it in token units (no oracle) →
 *        simulate the Aave action (no broadcast) → if clean, execute for real →
 *        report the tx.
 *
 * Every write is simulated first; nothing broadcasts unless the preflight is clean.
 * Run:  npm run guardian            (rescue for real)
 *       npm run guardian -- --dry-run   (decide + simulate only)
 */
import "../net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import OpenAI from "openai";
import { loadConfig } from "../config.js";
import { KeeperHub, type AavePosition, type UserReserveData } from "../keeperhub.js";
import { createLogger } from "../log.js";
import { RestExecutionTransport, type ExecutionTransport } from "../execution-transport.js";
import { safeAudit, type AuditSink, type AuditSource } from "../audit.js";
import { txHashFrom, verifyTransaction } from "../transaction-verifier.js";
import type { SettlementStatus } from "../verification.js";
import {
  type AssetPosition,
  type PositionSnapshot,
  type RescueDecision,
} from "./decide.js";
import { runAgenticRescue } from "./agent.js";
import { SEPOLIA_POOL, SEPOLIA_RESERVES, VARIABLE_RATE_MODE, type ReserveInfo } from "./assets.js";
import { readPriceUsd } from "./prices.js";
import { rpc } from "../../server/rescues.js";

const logger = createLogger("guardian");
/** Human-facing pass log (plain console lines for the CLI demo). */
function log(msg: string): void {
  logger.info(msg);
}

export interface GuardianResult {
  status: "healthy" | "rescued" | "confirmed" | "partial" | "dry_run" | "simulation_failed" | "broadcast_failed" | "broadcast_pending" | "transaction_reverted" | "verification_failed" | "no_action";
  position: AavePosition;
  decision?: RescueDecision;
  transactionHash?: string;
  transactionLink?: string;
  executionId?: string;
  settlement?: SettlementStatus | "verification_failed";
  gasUsed?: string;
  gasCostWei?: string;
  detail?: string;
  provider?: "llm" | "deterministic";
}

/** LLM stack for the decision layer: an OpenAI-compatible client + timeout. */
export interface LlmConfig {
  client: OpenAI;
  /** Model id served by the configured base URL. */
  model: string;
  /** Per-attempt budget in ms. */
  timeoutMs?: number;
}

/**
 * One full guardian pass over a single position.
 *
 * Thin wrapper over the agentic rescue loop for backward compatibility: the CLI
 * and bot call this with the old signature and get the same statuses, but the
 * decision now runs inside {@link runAgenticRescue} (which re-perceives between
 * steps, so a multi-step rescue is possible when `maxSteps > 1`).
 */
export async function runGuardianOnce(opts: {
  keeperHub: KeeperHub;
  /** LLM stack for the decision. If null, deterministic sizing is used. */
  llm: LlmConfig | null;
  chainId: string;
  user: string;
  hfThreshold: number;
  hfTarget: number;
  /** Optional hints — no longer required; composition is discovered on-chain. */
  debtAsset?: string;
  collateralAsset?: string;
  /** When true, stop after a clean simulation — don't broadcast. */
  dryRun?: boolean;
  /** Max rescue steps per run (default 1 — the old single-decision behavior). */
  maxSteps?: number;
  /** Optional execution transport. Omitted for the default REST path. */
  transport?: ExecutionTransport;
  audit?: { sink: AuditSink; runId: string; source: AuditSource; threshold?: number; target?: number };
}): Promise<GuardianResult> {
  const { keeperHub, llm, chainId, user, hfThreshold, hfTarget } = opts;

  const run = await runAgenticRescue({
    keeperHub,
    llm,
    chainId,
    user,
    hfThreshold,
    hfTarget,
    maxSteps: opts.maxSteps ?? 1,
    dryRun: opts.dryRun,
    transport: opts.transport,
    audit: opts.audit,
  });
  const last = run.steps[run.steps.length - 1];

  switch (run.status) {
    case "healthy":
      return { status: "healthy", position: run.position, detail: run.summary };
    case "no_action":
      return { status: "no_action", position: run.position, detail: run.summary };
    case "goal_met":
      return {
        status: "rescued",
        position: run.position,
        decision: last?.decision,
        provider: last?.provider === "llm" ? "llm" : "deterministic",
        transactionHash: last?.transactionLink
          ? extractHash(last.transactionLink)
          : undefined,
        transactionLink: last?.transactionLink,
        detail: run.summary,
      };
    case "budget_hit": {
      // A run that stopped before the goal. If the last step failed at
      // simulate/execute, surface that; otherwise report the partial progress.
      const failed = run.steps.find((s) => s.status === "simulation_failed");
      if (failed) {
        return {
          status: "simulation_failed",
          position: run.position,
          decision: failed.decision,
          detail: run.summary,
        };
      }
      if (run.steps.length === 0) {
        return { status: "healthy", position: run.position, detail: run.summary };
      }
      // Partial progress: the position improved but the budget ran out. The
      // old statuses have no "partial" — report the last action + tx.
      return {
        status: "rescued",
        position: run.position,
        decision: last?.decision,
        provider: last?.provider === "llm" ? "llm" : "deterministic",
        transactionHash: last?.transactionLink
          ? extractHash(last.transactionLink)
          : undefined,
        transactionLink: last?.transactionLink,
        detail: `${run.summary} ${run.steps.length} step(s).`,
      };
    }
  }
}

/** Pull the 0x… hash out of a transactionLink if it carries one. */
function extractHash(link: string): string | undefined {
  const m = link.match(/0x[0-9a-fA-F]{64}/);
  return m?.[0];
}

/**
 * Build, preflight, and (unless `dryRun`) broadcast a single already-decided rescue,
 * then confirm the health factor recovered. This is steps 5–9 of {@link runGuardianOnce},
 * factored out so a caller that has ALREADY chosen the lever — the Telegram bot on a
 * one-tap approval, via `candidateToDecision(chosen)` — can execute it without
 * re-reading, re-deciding, or re-running the LLM.
 *
 * Invariant preserved: every write is simulated first and nothing broadcasts unless
 * the preflight is clean.
 *
 * `position` (the pre-rescue read) is optional and used only to populate the result
 * on a `simulation_failed`/`dry-run` path; on a successful broadcast the returned
 * `position` is always the fresh post-rescue read.
 */
export async function executeRescue(opts: {
  keeperHub: KeeperHub;
  chainId: string;
  user: string;
  decision: RescueDecision;
  dryRun?: boolean;
  /** Pre-rescue position, if the caller already has it (avoids a redundant read on failure paths). */
  position?: AavePosition;
  /** Optional alternate execution transport. Omitted callers use REST. */
  transport?: ExecutionTransport;
  audit?: { sink: AuditSink; runId: string; source: AuditSource; threshold?: number; target?: number; dryRun?: boolean };
}): Promise<GuardianResult> {
  const { keeperHub, chainId, user, decision } = opts;
  const transport = opts.transport ?? new RestExecutionTransport(keeperHub);
  const position = opts.position ?? (await keeperHub.readAavePosition(chainId, user));

  // 5. Build the Aave action body (amount is already token base units; asset address
  //    comes from the decision, so we don't re-resolve).
  const actionType = decision.action === "repay" ? "aave-v3/repay" : "aave-v3/supply";
  const body: Record<string, unknown> =
    decision.action === "repay"
      ? {
          chainId,
          asset: decision.assetAddress,
          amount: decision.amountUnits.toString(),
          interestRateMode: VARIABLE_RATE_MODE,
          onBehalfOf: user,
        }
      : {
          chainId,
          asset: decision.assetAddress,
          amount: decision.amountUnits.toString(),
          onBehalfOf: user,
          referralCode: "0",
        };

  // 6. Simulate first — never broadcast a call we haven't preflighted.
  log(`Simulating ${actionType} (${decision.amountUnits} base units)…`);
  await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "simulation", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, dryRun: opts.dryRun, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), threshold: opts.audit?.threshold, target: opts.audit?.target });
  const sim = await transport.simulateAction(actionType, body);
  if (!sim.success || sim.wouldRevert) {
    const detail = sim.error ?? "would revert";
    log(`Simulation failed: ${detail}`);
    await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "failed", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, dryRun: opts.dryRun, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: false, wouldRevert: sim.wouldRevert, error: detail });
    return { status: "simulation_failed", position, decision, detail };
  }
  log("Simulation clean.");
  await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "simulation", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, dryRun: opts.dryRun, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: true, wouldRevert: false, gasEstimate: sim.gasEstimate });

  if (opts.dryRun) {
    return { status: "dry_run", position, decision, detail: "dry-run: simulated only, not broadcast." };
  }

  // 7. Execute for real, then wait for a terminal KeeperHub result.
  log(`Broadcasting rescue via KeeperHub (${transport.name})…`);
  await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "broadcast", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString() });
  const exec = await transport.executeAction(actionType, body);
  if (!exec.success || !exec.executionId) {
    const detail = exec.error ?? "execution request failed";
    await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "failed", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: false, error: detail });
    return { status: "broadcast_failed", position, decision, detail };
  }
  log(`Execution accepted: ${exec.executionId}`);
  const settlement = await transport.waitForExecution(exec.executionId);
  const txHash = txHashFrom(settlement);
  if (settlement.status === "pending") {
    return { status: "broadcast_pending", position, decision, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, settlement: "pending", detail: "Execution did not reach a terminal state before the timeout." };
  }
  if (settlement.status !== "confirmed" || !txHash) {
    const status = settlement.status === "reverted" ? "transaction_reverted" : "broadcast_failed";
    const detail = settlement.error ?? "KeeperHub execution did not complete successfully.";
    await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "failed", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: false, status: settlement.status, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, error: detail });
    return { status, position, decision, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, settlement: settlement.status, detail };
  }
  const verification = await verifyTransaction({ txHash, expected: { action: decision.action, asset: decision.assetAddress, user, amountUnits: decision.amountUnits } });
  if (verification.status !== "confirmed") {
    const detail = verification.reason ?? "Transaction verification failed.";
    await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "failed", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: false, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, error: detail });
    return { status: verification.status === "reverted" ? "transaction_reverted" : verification.status === "pending" ? "broadcast_pending" : "verification_failed", position, decision, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, settlement: verification.status, gasUsed: verification.receipt?.gasUsed.toString(), gasCostWei: verification.gasCostWei, detail };
  }
  log(`✅ Confirmed. tx: ${settlement.transactionLink ?? txHash}`);
  await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "broadcast", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: true, status: settlement.status, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, gasEstimate: sim.gasEstimate });

  // 8. Confirm the position after the receipt and expected Aave event are verified.
  const after = await keeperHub.readAavePosition(chainId, user).catch(() => position);
  const finalStatus = opts.audit?.target != null && after.healthFactor < opts.audit.target ? "partial" : "confirmed";
  await safeAudit(opts.audit?.sink, { runId: opts.audit?.runId ?? "", phase: "confirmation", source: opts.audit?.source ?? "cli", chainId, wallet: user, transport: transport.name, healthFactorBefore: position.healthFactor, healthFactorAfter: after.healthFactor, action: decision.action, asset: decision.asset, amountHuman: decision.amountHuman, amountUnits: decision.amountUnits.toString(), success: true, status: finalStatus, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, error: undefined });
  return { status: finalStatus, position: after, decision, executionId: exec.executionId, transactionHash: txHash, transactionLink: settlement.transactionLink ?? exec.transactionLink, settlement: "confirmed", gasUsed: verification.receipt?.gasUsed.toString(), gasCostWei: verification.gasCostWei };
}

/**
 * Discover a position's on-chain composition and size it into a {@link PositionSnapshot}.
 *
 * Scans every known Sepolia reserve for this user's debt/collateral balances (one
 * read each — ~9 calls, well under the 60/min limit), then fetches Chainlink USD
 * prices ONLY for a side that holds ≥2 assets. A single-asset side (the LINK/LINK
 * demo) makes zero oracle calls and stays on the exact price-free math path.
 *
 * Exported so the read-position script builds the identical snapshot the guardian does.
 */
export async function buildSnapshot(
  keeperHub: KeeperHub,
  chainId: string,
  user: string,
  position: AavePosition,
): Promise<PositionSnapshot> {
  const reserves = Object.values(SEPOLIA_RESERVES);

  // Read every reserve in parallel, but degrade gracefully: one failing/unreadable
  // reserve must not lose the whole snapshot — the user's actual position is
  // discovered from whatever reserves DID read. A total read failure still throws.
  const reads = (
    await Promise.all(
      reserves.map(async (r) => {
        try {
          const data = await keeperHub.readUserReserve(chainId, r.address, user);
          return { reserve: r, data };
        } catch (err) {
          logger.warn(`reserve read failed for ${r.symbol}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    )
  ).filter((x): x is { reserve: ReserveInfo; data: UserReserveData } => x !== null);

  const debts: AssetPosition[] = [];
  const collaterals: AssetPosition[] = [];
  for (const { reserve, data } of reads) {
    if (data.variableDebt > 0n) {
      debts.push(assetOf(reserve, data.variableDebt));
    }
    // Only collateral that's actually enabled contributes to the health factor.
    if (data.aTokenBalance > 0n && data.usageAsCollateralEnabled) {
      collaterals.push(assetOf(reserve, data.aTokenBalance));
    }
  }

  // Prices are needed only for a side with ≥2 assets (otherwise price cancels).
  if (debts.length >= 2) {
    await Promise.all(
      debts.map(async (d) => {
        d.priceUsd = (await readPriceUsd(keeperHub, chainId, d.symbol)) ?? undefined;
      }),
    );
  }
  if (collaterals.length >= 2) {
    await Promise.all(
      collaterals.map(async (c) => {
        c.priceUsd = (await readPriceUsd(keeperHub, chainId, c.symbol)) ?? undefined;
        // liqThresholdBps is already attached from the reserve registry (assetOf).
      }),
    );
  }

  // Executability data: wallet balance + Aave Pool allowance for every asset in
  // the position. Levers are only offered when these cover the sized amount, so
  // the LLM/fallback never pick a rescue that would fail at simulate with
  // "transfer amount exceeds allowance". Reads degrade gracefully (0n on failure).
  const walletBalances: Record<string, bigint> = {};
  const allowances: Record<string, bigint> = {};
  const positionAssets = [...debts, ...collaterals];
  await Promise.all(
    positionAssets.map(async (a) => {
      const symbol = a.symbol.toUpperCase();
      walletBalances[symbol] = await keeperHub.readErc20(chainId, a.address, "balanceOf", user);
      allowances[symbol] = await keeperHub.readErc20(chainId, a.address, "allowance", user, SEPOLIA_POOL);
    }),
  );

  // Gas awareness: fetch the network gas price (via the same public RPC used for
  // event reads) + the ETH/USD price, so each lever can show an estimated gas
  // cost in the LLM prompt. Both degrade gracefully to null on failure — the
  // decision layer simply sees no gas figure (same as before this feature).
  let gasPriceGwei: number | null = null;
  let ethPriceUsd: number | null = null;
  try {
    const gasRaw = await rpc("eth_gasPrice", []);
    if (typeof gasRaw === "string") {
      gasPriceGwei = Number(BigInt(gasRaw)) / 1e9; // wei → Gwei
    }
  } catch (err) {
    logger.warn("gas price read failed", { error: err instanceof Error ? err.message : String(err) });
  }
  ethPriceUsd = await readPriceUsd(keeperHub, chainId, "WETH");

  return {
    healthFactor: position.healthFactor,
    totalDebtUsd: position.totalDebtUsd,
    totalCollateralUsd: position.totalCollateralUsd,
    aggregateLiqThreshold: position.liquidationThreshold,
    debts,
    collaterals,
    walletBalances,
    allowances,
    gasPriceGwei,
    ethPriceUsd,
  };
}

function assetOf(r: ReserveInfo, tokens: bigint): AssetPosition {
  return {
    symbol: r.symbol,
    address: r.address,
    decimals: r.decimals,
    tokens,
    liqThresholdBps: r.liqThresholdBps,
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig(); // LLM keys optional — deterministic fallback if absent.
  const keeperHub = new KeeperHub({ apiKey: cfg.keeperHubApiKey });

  // LLM: any OpenAI-compatible provider configured via env (key, base URL, model).
  // Falls back to deterministic sizing if the provider is unreachable.
  const llm: LlmConfig | null = cfg.llmApiKey
    ? {
        client: new OpenAI({
          apiKey: cfg.llmApiKey,
          baseURL: cfg.llmBaseUrl,
        }),
        model: cfg.llmModel,
        timeoutMs: cfg.llmTimeoutMs,
      }
    : null;

  if (llm) {
    console.log(`(LLM: ${cfg.llmModel} via ${cfg.llmBaseUrl}, ${cfg.llmTimeoutMs}ms budget)`);
  } else {
    console.log("(No LLM_API_KEY set — running with the deterministic fallback decision.)");
  }
  const dryRun = process.argv.includes("--dry-run");
  // --max-steps N: how many rescue steps one run may take before re-checking
  // (default 1 = the classic single decision; >1 turns on the agentic loop).
  const maxStepsArg = process.argv.indexOf("--max-steps");
  const maxSteps =
    maxStepsArg >= 0
      ? Number(process.argv[maxStepsArg + 1])
      : 1;

  runGuardianOnce({
    keeperHub,
    llm,
    chainId: cfg.chainId,
    user: cfg.walletAddress,
    hfThreshold: cfg.hfThreshold,
    hfTarget: cfg.hfTarget,
    debtAsset: cfg.debtAsset,
    collateralAsset: cfg.collateralAsset,
    dryRun,
    maxSteps,
  })
    .then((r) => {
      console.log(
        "\nResult:",
        JSON.stringify(
          { status: r.status, hf: r.position.healthFactor, tx: r.transactionLink, detail: r.detail },
          null,
          2,
        ),
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Guardian error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
