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
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../config.js";
import { KeeperHub, type AavePosition } from "../keeperhub.js";
import {
  decideRescue,
  decideRescueDeterministic,
  type AssetPosition,
  type PositionSnapshot,
  type RescueDecision,
} from "./decide.js";
import { SEPOLIA_RESERVES, VARIABLE_RATE_MODE, type ReserveInfo } from "./assets.js";
import { readPriceUsd } from "./prices.js";

export interface GuardianResult {
  status: "healthy" | "rescued" | "simulation_failed" | "no_action";
  position: AavePosition;
  decision?: RescueDecision;
  transactionHash?: string;
  transactionLink?: string;
  detail?: string;
}

/** One full guardian pass over a single position. */
export async function runGuardianOnce(opts: {
  keeperHub: KeeperHub;
  /** LLM client for the decision. If null, a deterministic fallback is used. */
  anthropic: Anthropic | null;
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
  const { keeperHub, anthropic, chainId, user, hfThreshold, hfTarget } = opts;

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
  //    Use the LLM when available; fall back to deterministic sizing if not, so
  //    the position stays protected even when the LLM is unreachable.
  let decision: RescueDecision;
  if (anthropic) {
    log("⚠️  Below threshold — asking the decision layer for the fix…");
    try {
      decision = await decideRescue(anthropic, { snapshot, hfThreshold, hfTarget });
    } catch (err) {
      log(`LLM decision failed (${err instanceof Error ? err.message : err}); using deterministic fallback.`);
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
  log("Broadcasting rescue via KeeperHub…");
  const exec = await keeperHub.executeAction(actionType, body);
  if (!exec.success) {
    return { status: "simulation_failed", position, decision, detail: exec.error };
  }
  log(`✅ Rescued. tx: ${exec.transactionLink ?? exec.transactionHash}`);

  // 8. Confirm the health factor actually recovered.
  const after = await keeperHub.readAavePosition(chainId, user);
  log(`Health factor after rescue: ${fmtHf(after.healthFactor)}`);

  return {
    status: "rescued",
    position: after,
    decision,
    transactionHash: exec.transactionHash,
    transactionLink: exec.transactionLink,
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

  const reads = await Promise.all(
    reserves.map(async (r) => ({
      reserve: r,
      data: await keeperHub.readUserReserve(chainId, r.address, user),
    })),
  );

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

function log(msg: string): void {
  console.log(msg);
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig(); // Anthropic key optional — deterministic fallback if absent.
  const keeperHub = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
  const anthropic = cfg.anthropicApiKey
    ? new Anthropic({
        apiKey: cfg.anthropicApiKey,
        // Route through a proxy/router when BASE_URL is set; else SDK default.
        ...(cfg.anthropicBaseUrl ? { baseURL: cfg.anthropicBaseUrl } : {}),
      })
    : null;
  if (anthropic && cfg.anthropicBaseUrl) {
    console.log(`(Using Anthropic router at ${cfg.anthropicBaseUrl})`);
  }
  if (!anthropic) {
    console.log("(No ANTHROPIC_API_KEY set — running with the deterministic fallback decision.)");
  }
  const dryRun = process.argv.includes("--dry-run");

  runGuardianOnce({
    keeperHub,
    anthropic,
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
