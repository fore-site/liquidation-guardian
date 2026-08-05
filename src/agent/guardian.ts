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
  decideRescueWithFallback,
  decideRescueDeterministic,
  type AssetPosition,
  type PositionSnapshot,
  type RescueDecision,
} from "./decide.js";
import { SEPOLIA_RESERVES, VARIABLE_RATE_MODE, type ReserveInfo } from "./assets.js";
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

/** LLM stack for the decision layer: primary + optional Gemini fallback + timeout. */
export interface LlmConfig {
  primary: OpenAI;
  /** Model id on the primary provider (e.g. NVIDIA's catalog). */
  primaryModel?: string;
  /** Optional Gemini free-tier fallback (OpenAI-compatible endpoint). */
  gemini?: OpenAI;
  geminiModel?: string;
  /** Per-attempt budget in ms. */
  timeoutMs?: number;
}

/** One full guardian pass over a single position. */
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
}): Promise<GuardianResult> {
  const { keeperHub, llm, chainId, user, hfThreshold, hfTarget } = opts;

  // 1. Read the live position.
  const position = await keeperHub.readAavePosition(chainId, user);
  log(`Health factor: ${fmtHf(position.healthFactor)}  (act below ${hfThreshold})`);
  log(`  collateral $${position.totalCollateralUsd.toFixed(2)} · debt $${position.totalDebtUsd.toFixed(2)}`);

  // 2. Healthy? Nothing to do — the cheap, common case.
  if (position.healthFactor >= hfThreshold) {
    log("Position healthy — no action.");
    return { status: "healthy", position };
  }
  if (position.totalDebtUsd <= 0) {
    return { status: "no_action", position, detail: "No debt to manage." };
  }

  // 3. Discover the position's actual composition (which reserves the user holds as
  //    debt / collateral), then size every lever. Prices are fetched ONLY for a side
  //    that holds ≥2 assets — a single-asset side (our LINK/LINK demo) needs none.
  const snapshot = await buildSnapshot(keeperHub, chainId, user, position);
  if (snapshot.debts.length === 0) {
    return { status: "no_action", position, detail: "No debt reserves found to manage." };
  }
  log(
    `  debts: ${snapshot.debts.map((d) => d.symbol).join(", ")} · ` +
      `collaterals: ${snapshot.collaterals.map((c) => c.symbol).join(", ")}`,
  );

  // 4. At risk — decide which lever to pull (amount sized in code either way).
  //    Use the LLM stack when available; fall back to deterministic sizing if not,
  //    so the position stays protected even when every LLM is unreachable.
  let decision: RescueDecision;
  if (llm) {
    log("⚠️  Below threshold — asking the decision layer for the fix…");
    try {
      const { decision: d, source } = await decideRescueWithFallback({
        primary: llm.primary,
        primaryModel: llm.primaryModel,
        gemini: llm.gemini,
        geminiModel: llm.geminiModel,
        timeoutMs: llm.timeoutMs,
        input: { snapshot, hfThreshold, hfTarget },
      });
      decision = d;
      log(`  (decided by ${source.provider})`);
    } catch (err) {
      logger.warn("LLM decision failed; using deterministic fallback", {
        error: err instanceof Error ? err.message : String(err),
      });
      decision = decideRescueDeterministic(snapshot, hfTarget);
    }
  } else {
    log("⚠️  Below threshold — no LLM key; using deterministic fallback.");
    decision = decideRescueDeterministic(snapshot, hfTarget);
  }
  log(`Decision: ${decision.action} ${decision.amountHuman} ${decision.asset}`);
  log(`  reasoning: ${decision.reasoning}`);

  if (decision.amountUnits <= 0n) {
    return { status: "no_action", position, decision, detail: "Computed rescue amount is zero." };
  }

  // 5–9. Build → simulate → (dry-run stop) → execute → confirm.
  return executeRescue({ keeperHub, chainId, user, decision, dryRun: opts.dryRun, position });
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

  return {
    healthFactor: position.healthFactor,
    totalDebtUsd: position.totalDebtUsd,
    totalCollateralUsd: position.totalCollateralUsd,
    aggregateLiqThreshold: position.liquidationThreshold,
    debts,
    collaterals,
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

  // Primary LLM: NVIDIA NIM (OpenAI-compatible endpoint).
  const llm: LlmConfig | null = cfg.nvidiaApiKey
    ? {
        primary: new OpenAI({
          apiKey: cfg.nvidiaApiKey,
          // Route through the NVIDIA NIM endpoint (or another OpenAI-compatible
          // gateway) when BASE_URL is set; else the OpenAI SDK default.
          ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
        }),
        primaryModel: cfg.llmModel,
        timeoutMs: cfg.llmTimeoutMs,
        // Optional Gemini free-tier fallback (OpenAI-compatible endpoint).
        ...(cfg.geminiApiKey
          ? {
              gemini: new OpenAI({
                apiKey: cfg.geminiApiKey,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
              }),
              geminiModel: cfg.geminiModel,
            }
          : {}),
      }
    : null;

  if (llm) {
    console.log(`(LLM: ${cfg.llmModel} via ${cfg.openaiBaseUrl || "OpenAI SDK default"}${cfg.geminiApiKey ? " · Gemini fallback" : ""}, ${cfg.llmTimeoutMs}ms budget)`);
  } else {
    console.log("(No NVIDIA_API_KEY set — running with the deterministic fallback decision.)");
  }
  const dryRun = process.argv.includes("--dry-run");

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
