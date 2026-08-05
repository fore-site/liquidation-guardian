/**
 * Read + print the live Aave v3 position for the configured wallet.
 *
 * This is the read half of the Guardian — no LLM, no credentials-sensitive write,
 * safe to run anytime. Use it to watch the health factor while setting up the demo
 * position (supply collateral → borrow → watch HF fall). It discovers the position's
 * actual asset composition and prints every rescue lever the Guardian could pull,
 * sized exactly — with zero price reads for a single-asset-per-side position.
 *
 * Run:  npm run read-position
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { loadConfig } from "../src/config.js";
import { KeeperHub } from "../src/keeperhub.js";
import { buildSnapshot } from "../src/agent/guardian.js";
import { computeCandidates } from "../src/agent/decide.js";

async function main(): Promise<void> {
  const cfg = loadConfig(); // Anthropic key not required for a read.
  const keeperHub = new KeeperHub({ apiKey: cfg.keeperHubApiKey });

  const pos = await keeperHub.readAavePosition(cfg.chainId, cfg.walletAddress);

  console.log(`\nAave v3 position — ${cfg.walletAddress} on chain ${cfg.chainId}\n`);
  console.log(`  Health factor        : ${fmtHf(pos.healthFactor)}`);
  console.log(`  Collateral (USD)     : $${pos.totalCollateralUsd.toFixed(2)}`);
  console.log(`  Debt (USD)           : $${pos.totalDebtUsd.toFixed(2)}`);
  console.log(`  Available borrows    : $${pos.availableBorrowsUsd.toFixed(2)}`);
  console.log(`  Liquidation threshold: ${(pos.liquidationThreshold * 100).toFixed(1)}%`);

  if (Number.isFinite(pos.healthFactor) && pos.totalDebtUsd > 0) {
    const status =
      pos.healthFactor < cfg.hfThreshold
        ? `⚠️  BELOW threshold (${cfg.hfThreshold}) — the Guardian would act`
        : `✅ healthy (threshold ${cfg.hfThreshold})`;
    console.log(`\n  ${status}`);

    // Discover composition and show the exact rescue options (prices fetched only if a
    // side has ≥2 assets; a single-asset-per-side position reads zero oracles).
    const snap = await buildSnapshot(keeperHub, cfg.chainId, cfg.walletAddress, pos);
    console.log(
      `\n  Composition: debts [${snap.debts.map((d) => d.symbol).join(", ") || "none"}], ` +
        `collaterals [${snap.collaterals.map((c) => c.symbol).join(", ") || "none"}]`,
    );

    if (pos.healthFactor < cfg.hfTarget) {
      const candidates = computeCandidates(snap, cfg.hfTarget);
      console.log(`\n  To restore HF to ${cfg.hfTarget}, any one of:`);
      for (const c of candidates) {
        if (c.available) {
          const partial = c.action === "repay" && !c.reachesTarget ? " (partial — can't reach target alone)" : "";
          console.log(`    • ${c.action.padEnd(6)} ${human(c.amountHuman)} ${c.asset.symbol}${partial}`);
        } else {
          console.log(`    • ${c.action.padEnd(6)} ${c.asset.symbol} — unavailable (${c.note})`);
        }
      }
    }
  } else {
    console.log(`\n  No debt — nothing to guard yet. Run 'npm run setup-position' to open one.`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\nread-position failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

function fmtHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(4) : "∞ (no debt)";
}
function human(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
