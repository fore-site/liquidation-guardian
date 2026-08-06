/**
 * Liquidation Guardian — orchestration loop.
 *
 * This is the "LLM decides, KeeperHub executes" half of the system. The always-on
 * watching is a deterministic KeeperHub workflow (see src/workflows/); this process
 * is what that workflow hands off to once a position is actually at risk.
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
import {
  type AssetPosition,
  type PositionSnapshot,
  type RescueDecision,
} from "./decide.js";
import { runAgenticRescue } from "./agent.js";
import { SEPOLIA_POOL, SEPOLIA_RESERVES, VARIABLE_RATE_MODE, type ReserveInfo } from "./assets.js";
import { readPriceUsd } from "./prices.js";

const logger = createLogger("guardian");
/** Human-facing pass log (plain console lines for the CLI demo). */
function log(msg: string): void {
  logger.info(msg);
}

export interface GuardianResult {
  status: "healthy" | "rescued" | "simulation_failed" | "no_action";
  position: AavePosition;
  decision?: RescueDecision;
  transactionHash?: string;
  transactionLink?: string;
  detail?: string;
}

/** LLM stack for the decision layer: primary + optional fallback + timeout. */
export interface LlmConfig {
  primary: OpenAI;
  /** Model id on the primary provider (Gemini). */
  primaryModel?: string;
  /** Optional NVIDIA NIM fallback (OpenAI-compatible endpoint). */
  fallback?: OpenAI;
  fallbackModel?: string;
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
}): Promise<GuardianResult> {
  const { keeperHub, chainId, user, decision } = opts;
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
  const sim = await keeperHub.executeAction(actionType, body, { simulate: true });
  if (!sim.success) {
    log(`Simulation failed: ${sim.error}`);
    return { status: "simulation_failed", position, decision, detail: sim.error };
  }
  log("Simulation clean.");

  if (opts.dryRun) {
    return { status: "rescued", position, decision, detail: "dry-run: simulated only, not broadcast." };
  }

  // 7. Execute for real (fresh idempotency key inside executeAction).
  log(`Broadcasting rescue via KeeperHub…`);
  const exec = await keeperHub.executeAction(actionType, body);
  if (!exec.success) {
    return { status: "simulation_failed", position, decision, detail: exec.error };
  }
  log(`✅ Rescued. tx: ${exec.transactionLink ?? exec.transactionHash}`);

  // 8. Confirm the health factor actually recovered. The broadcast already
  //    succeeded — a failed confirm read must NOT turn a successful rescue into a
  //    reported failure; we surface the tx and note the confirm was skipped.
  let after = position;
  let confirmNote = "";
  try {
    after = await keeperHub.readAavePosition(chainId, user);
    log(`Health factor after rescue: ${fmtHf(after.healthFactor)}`);
  } catch (err) {
    confirmNote = ` (post-rescue confirm read failed: ${err instanceof Error ? err.message : err})`;
    logger.warn("post-rescue confirm read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    status: "rescued",
    position: after,
    decision,
    transactionHash: exec.transactionHash,
    transactionLink: exec.transactionLink,
    detail: confirmNote || undefined,
  };
}

function fmtHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(4) : "∞ (no debt)";
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

  return {
    healthFactor: position.healthFactor,
    totalDebtUsd: position.totalDebtUsd,
    totalCollateralUsd: position.totalCollateralUsd,
    aggregateLiqThreshold: position.liquidationThreshold,
    debts,
    collaterals,
    walletBalances,
    allowances,
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

  // Primary LLM: Gemini (OpenAI-compatible endpoint — fast, reliable).
  const llm: LlmConfig | null = cfg.geminiApiKey
    ? {
        primary: new OpenAI({
          apiKey: cfg.geminiApiKey,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        }),
        primaryModel: cfg.geminiModel,
        timeoutMs: cfg.llmTimeoutMs,
        // Optional NVIDIA NIM fallback (OpenAI-compatible endpoint).
        ...(cfg.nvidiaApiKey
          ? {
              fallback: new OpenAI({
                apiKey: cfg.nvidiaApiKey,
                // Route through the NVIDIA NIM endpoint (or another OpenAI-compatible
                // gateway) when BASE_URL is set; else the OpenAI SDK default.
                ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
              }),
              fallbackModel: cfg.llmModel,
            }
          : {}),
      }
    : null;

  if (llm) {
    console.log(`(LLM: ${cfg.geminiModel} via Gemini${cfg.nvidiaApiKey ? ` · NVIDIA fallback (${cfg.llmModel})` : ""}, ${cfg.llmTimeoutMs}ms budget)`);
  } else {
    console.log("(No GEMINI_API_KEY set — running with the deterministic fallback decision.)");
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
