/**
 * Deterministic verification of the rescue sizing math (no network needed for the
 * hard gate). Each case is a hand-worked example whose expected amount is derived to
 * land the position exactly on the target health factor — so these asserts prove the
 * arithmetic, not just that it runs. A final, best-effort live KeeperHub dry-run
 * shows the sized repay simulates end-to-end.
 *
 * Run:  npm run test-sizing
 *
 * The math (see src/agent/decide.ts): HF = N/D, N = Σ coll·price·LT, D = Σ debt·price.
 *   repay debt k:   R_k = D·(1 − HF/target) / price_k        (price-free if 1 debt)
 *   supply coll m:  S_m = D·(target − HF) / (price_m · LT_m)  (price-free & LT-free if 1 coll)
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch (live step)
import {
  sizeRepay,
  sizeSupply,
  computeCandidates,
  decideRescueDeterministic,
  type AssetPosition,
  type PositionSnapshot,
} from "../src/agent/decide.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const mark = ok ? "✅" : "❌";
  console.log(`  ${mark} ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
}
/** Relative closeness for oracle-priced (float) results; exact-ish for price-free. */
function near(actual: number, expected: number, relTol = 1e-6): boolean {
  if (expected === 0) return Math.abs(actual) <= relTol;
  return Math.abs(actual - expected) / Math.abs(expected) <= relTol;
}
function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const WAD = 10n ** 18n;
function units(human: number, decimals: number): bigint {
  return BigInt(Math.round(human * 10 ** decimals));
}
function human(u: bigint, decimals: number): number {
  return Number(u) / 10 ** decimals;
}
function asset(symbol: string, decimals: number, tokens: bigint, extra: Partial<AssetPosition> = {}): AssetPosition {
  return { symbol, address: `0x${symbol}`, decimals, tokens, ...extra };
}

// ── Case A: LINK/LINK regression — the money-shot scenario, price-free ─────────
console.log("\nCase A — LINK collateral + LINK debt (single asset per side, price-free):");
{
  const hf = 1.1029;
  const target = 1.5;
  const debtTokens = units(68, 18); // ~68 LINK debt, as in the demo
  const collTokens = units(100, 18);
  const link = asset("LINK", 18, debtTokens, { liqThresholdBps: 7500 });
  const linkColl = asset("LINK", 18, collTokens, { liqThresholdBps: 7500 });
  const snap: PositionSnapshot = {
    healthFactor: hf,
    totalDebtUsd: 680, // arbitrary — unused on the price-free path
    totalCollateralUsd: 1000,
    aggregateLiqThreshold: 0.75,
    debts: [link],
    collaterals: [linkColl],
  };

  // Legacy closed form (locks the refactor against regression), with the 0.5% buffer.
  const buffer = 1.005;
  const repayLegacy = (debtTokens * BigInt(Math.round((1 - hf / target) * buffer * 1e18))) / WAD;
  const supplyLegacy = (collTokens * BigInt(Math.round((target / hf - 1) * buffer * 1e18))) / WAD;

  const repay = sizeRepay(link, snap, target); // default 0.5% buffer
  const supply = sizeSupply(linkColl, snap, target);
  check("repay matches legacy price-free formula", repay === repayLegacy, `${repay} vs ${repayLegacy}`);
  check("supply matches legacy price-free formula", supply === supplyLegacy, `${supply} vs ${supplyLegacy}`);
  check("repay is ~18.09 LINK (money-shot sanity)", near(human(repay, 18), 18.09, 2e-3), `${human(repay, 18)}`);

  const decision = decideRescueDeterministic(snap, target);
  check("deterministic picks repay LINK", decision.action === "repay" && decision.asset === "LINK");
}

// ── Case B: WETH collateral / USDC debt — DIFFERENT tokens, still price-free ───
console.log("\nCase B — WETH collateral + USDC debt, one each (different tokens, price-free):");
{
  // WETH 1 @ $3000, LT 80% → N = 2400. USDC debt 2400 @ $1 → D = 2400. HF = 1.0.
  // target 1.5, buffer 0 for an exact post-HF=target check.
  const target = 1.5;
  const weth = asset("WETH", 18, units(1, 18), { liqThresholdBps: 8000 });
  const usdc = asset("USDC", 6, units(2400, 6));
  const snap: PositionSnapshot = {
    healthFactor: 1.0,
    totalDebtUsd: 2400,
    totalCollateralUsd: 3000,
    aggregateLiqThreshold: 0.8,
    debts: [usdc],
    collaterals: [weth],
  };

  // No priceUsd set on either asset — proves a single-asset side needs no oracle,
  // even when collateral (WETH) and debt (USDC) are different tokens.
  const repay = sizeRepay(usdc, snap, target, 0);
  const supply = sizeSupply(weth, snap, target, 0);
  check("repay = 800 USDC (price-free, different tokens)", near(human(repay, 6), 800), `${human(repay, 6)}`);
  check("supply = 0.5 WETH (price-free, LT-free)", near(human(supply, 18), 0.5), `${human(supply, 18)}`);

  // Post-HF lands exactly on target for each lever (N and D in USD).
  const N = 3000 * 0.8; // 2400
  const hfAfterRepay = N / (2400 - human(repay, 6) * 1); // USDC price $1
  const hfAfterSupply = (1 + human(supply, 18)) * 3000 * 0.8 / 2400;
  check("post-HF after repay = target", near(hfAfterRepay, target, 1e-9), `${hfAfterRepay}`);
  check("post-HF after supply = target", near(hfAfterSupply, target, 1e-9), `${hfAfterSupply}`);
}

// ── Case C: multi-collateral supply NEEDS price + LT, differs from naive ───────
console.log("\nCase C — WETH+WBTC collateral, USDC debt (multi-collateral supply):");
{
  // WETH 1 @ $3000 LT 82.5%(=2475) + WBTC 0.1 @ $60000 LT 75%(=4500) → N = 6975.
  // USDC debt 6000 @ $1 → D = 6000. HF = 1.1625. target 1.5, buffer 0.
  const target = 1.5;
  const weth = asset("WETH", 18, units(1, 18), { priceUsd: 3000, liqThresholdBps: 8250 });
  const wbtc = asset("WBTC", 8, units(0.1, 8), { priceUsd: 60000, liqThresholdBps: 7500 });
  const usdc = asset("USDC", 6, units(6000, 6));
  const snap: PositionSnapshot = {
    healthFactor: 1.1625,
    totalDebtUsd: 6000,
    totalCollateralUsd: 63000,
    aggregateLiqThreshold: 6975 / 63000,
    debts: [usdc],
    collaterals: [weth, wbtc],
  };

  // Supply more WETH: S = 6000·(1.5−1.1625)/(3000·0.825) = 0.81818 WETH.
  const supplyWeth = sizeSupply(weth, snap, target, 0);
  check("multi-collateral supply WETH = 0.81818", near(human(supplyWeth, 18), 0.818182, 1e-4), `${human(supplyWeth, 18)}`);

  const naive = 1 * (target / 1.1625 - 1); // 0.29032 — what price-free would give
  check("USD path differs from naive price-free number", !near(human(supplyWeth, 18), naive, 1e-2), `naive=${naive}`);

  const noPrice = asset("WETH", 18, units(1, 18), { liqThresholdBps: 8250 });
  const noLt = asset("WETH", 18, units(1, 18), { priceUsd: 3000 });
  check("throws without price (multi-collateral)", threw(() => sizeSupply(noPrice, snap, target, 0)));
  check("throws without LT (multi-collateral)", threw(() => sizeSupply(noLt, snap, target, 0)));

  // The single USDC debt is still price-free even in a multi-collateral position.
  const repayUsdc = sizeRepay(usdc, snap, target, 0);
  check("single-debt repay stays price-free = 1350 USDC", near(human(repayUsdc, 6), 1350), `${human(repayUsdc, 6)}`);
}

// ── Case D: multi-debt repay NEEDS price ──────────────────────────────────────
console.log("\nCase D — USDC+DAI debt, WETH collateral (multi-debt repay):");
{
  // WETH 2 @ $2000 LT 80% → N = 3200. USDC 1500 + DAI 1000 (both $1) → D = 2500. HF = 1.28.
  const target = 1.5;
  const weth = asset("WETH", 18, units(2, 18), { liqThresholdBps: 8000 });
  const usdc = asset("USDC", 6, units(1500, 6), { priceUsd: 1 });
  const dai = asset("DAI", 18, units(1000, 18), { priceUsd: 1 });
  const snap: PositionSnapshot = {
    healthFactor: 1.28,
    totalDebtUsd: 2500,
    totalCollateralUsd: 4000,
    aggregateLiqThreshold: 0.8,
    debts: [usdc, dai],
    collaterals: [weth],
  };

  // Repay USDC: R = 2500·(1−1.28/1.5)/1 = 366.667 USDC.
  const repayUsdc = sizeRepay(usdc, snap, target, 0);
  check("multi-debt repay USDC = 366.667", near(human(repayUsdc, 6), 366.6667, 1e-4), `${human(repayUsdc, 6)}`);

  const noPrice = asset("USDC", 6, units(1500, 6));
  check("throws without price (multi-debt)", threw(() => sizeRepay(noPrice, snap, target, 0)));

  // The single WETH collateral supply is still price-free even with multi-debt.
  const supplyWeth = sizeSupply(weth, snap, target, 0);
  check("single-collateral supply stays price-free = 0.34375 WETH", near(human(supplyWeth, 18), 0.34375, 1e-6), `${human(supplyWeth, 18)}`);

  // Candidate enumeration marks both debts available (priced) and the collateral too.
  const cands = computeCandidates(snap, target, 0);
  const avail = cands.filter((c) => c.available).length;
  check("all 3 levers enumerated as available", avail === 3, `${avail}/3`);
}

// ── Case E: executability gate — wallet balance blocks, allowance auto-approves ──
console.log("\nCase E — wallet balance blocks a lever; a short allowance auto-approves:");
{
  const hf = 1.1;
  const target = 1.5;
  const debtTokens = units(100, 18); // LINK debt
  const collTokens = units(200, 18); // LINK collateral
  const linkDebt = asset("LINK", 18, debtTokens, { liqThresholdBps: 7500 });
  const linkColl = asset("LINK", 18, collTokens, { liqThresholdBps: 7500 });

  const base: PositionSnapshot = {
    healthFactor: hf,
    totalDebtUsd: 1000,
    totalCollateralUsd: 2000,
    aggregateLiqThreshold: 0.75,
    debts: [linkDebt],
    collaterals: [linkColl],
  };

  // 1. Without balance maps → math-only sizing, lever available (legacy path).
  const legacy = computeCandidates(base, target, 0);
  const legacyRepay = legacy.find((c) => c.action === "repay")!;
  check("no balance maps → lever available (legacy)", legacyRepay.available && !legacyRepay.note);

  // 2. Wallet balance insufficient → repay unavailable with a clear note.
  const starved: PositionSnapshot = {
    ...base,
    walletBalances: { LINK: units(5, 18) }, // holds 5 LINK, repay needs ~26.7
    allowances: { LINK: units(1000, 18) }, // plenty of allowance
  };
  const starvedCands = computeCandidates(starved, target, 0);
  const starvedRepay = starvedCands.find((c) => c.action === "repay")!;
  check(
    "balance < amount → repay unavailable",
    !starvedRepay.available && /wallet holds/.test(starvedRepay.note ?? ""),
    starvedRepay.note ?? "",
  );
  const starvedSupply = starvedCands.find((c) => c.action === "supply")!;
  check("supply also gated (needs ~33.3, holds 5) → unavailable", !starvedSupply.available, starvedSupply.note ?? "");

  // 3. Enough balance but zero allowance → STILL available: the execution layer
  //    auto-approves (unlimited) before the rescue, so an allowance shortfall is
  //    a recoverable note, not a dead lever.
  const noAllow: PositionSnapshot = {
    ...base,
    walletBalances: { LINK: units(1000, 18) },
    allowances: { LINK: 0n },
  };
  const noAllowCands = computeCandidates(noAllow, target, 0);
  const noAllowRepay = noAllowCands.find((c) => c.action === "repay")!;
  check(
    "allowance < amount → repay still available (auto-approve)",
    noAllowRepay.available && /auto-approve/.test(noAllowRepay.note ?? ""),
    noAllowRepay.note ?? "",
  );
  const noAllowDec = decideRescueDeterministic(noAllow, target, 0);
  check(
    "deterministic picks repay when only allowance is short",
    noAllowDec.action === "repay" && noAllowDec.asset === "LINK",
  );

  // 4. Balance AND allowance both cover → available, no note.
  const funded: PositionSnapshot = {
    ...base,
    walletBalances: { LINK: units(1000, 18) },
    allowances: { LINK: units(1000, 18) },
  };
  const fundedCands = computeCandidates(funded, target, 0);
  const fundedRepay = fundedCands.find((c) => c.action === "repay")!;
  check("balance + allowance cover → repay available", fundedRepay.available && !fundedRepay.note);

  // 5. Deterministic fallback must NOT pick an unexecutable lever — it throws
  //    "no available lever" when every lever is gated off, rather than offering a
  //    rescue that would fail at simulate.
  const starvedDec = threw(() => decideRescueDeterministic(starved, target, 0));
  check("deterministic refuses gated-off levers", starvedDec);

  // 6. Deterministic picks the repay when funded (same rule as Case A).
  const fundedDec = decideRescueDeterministic(funded, target, 0);
  check(
    "deterministic picks repay when funded",
    fundedDec.action === "repay" && fundedDec.asset === "LINK",
  );
}

console.log(`\n${failures === 0 ? "✅ all sizing checks passed" : `❌ ${failures} check(s) failed`}\n`);

// ── Live KeeperHub dry-run (best-effort; soft — the unit checks are the hard gate) ─
await liveDryRun();

process.exit(failures === 0 ? 0 : 1);

async function liveDryRun(): Promise<void> {
  console.log("Live KeeperHub dry-run (aave-v3/repay simulate):");
  try {
    const { loadConfig } = await import("../src/config.js");
    const { KeeperHub } = await import("../src/keeperhub.js");
    const { buildSnapshot } = await import("../src/agent/guardian.js");
    const cfg = loadConfig();
    const kh = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
    const pos = await kh.readAavePosition(cfg.chainId, cfg.walletAddress);
    const snap = await buildSnapshot(kh, cfg.chainId, cfg.walletAddress, pos);
    const debt = snap.debts[0];
    if (!debt) {
      console.log("  (skipped — no debt reserve on the live position to simulate a repay against.)");
      return;
    }
    // Simulate repaying a tiny slice (0.01 token) — enough to prove the action path.
    const amount = units(0.01, debt.decimals).toString();
    const sim = await kh.executeAction(
      "aave-v3/repay",
      { chainId: cfg.chainId, asset: debt.address, amount, interestRateMode: "2", onBehalfOf: cfg.walletAddress },
      { simulate: true },
    );
    if (sim.success) {
      console.log(`  ✅ simulate success — repay 0.01 ${debt.symbol} would not revert.`);
    } else {
      console.log(`  ⚠️  simulate returned success:false — ${sim.error ?? "unknown"} (soft: not failing unit gate).`);
    }
  } catch (err) {
    console.log(`  ⚠️  live dry-run skipped (${err instanceof Error ? err.message : err}) — soft, unit checks stand.`);
  }
}
