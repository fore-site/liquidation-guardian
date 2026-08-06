/**
 * Set up a demo Aave v3 position on Sepolia that the Guardian can then rescue.
 *
 * On a testnet you can't crash prices, and Aave won't let you borrow past its LTV
 * cap — so the honest way to create an at-risk position is to borrow *right up to*
 * the limit, leaving the health factor just above liquidation and below the
 * Guardian's action threshold. This script does exactly that; the Guardian then
 * repays a little to restore it. Nothing here is faked — it's a real position.
 *
 * Asset = LINK for both collateral and debt. That isn't a simplification, it's what
 * this Sepolia deployment allows: the stablecoin reserves are supply-capped and have
 * no borrow liquidity (see docs/TEARDOWN.md). A single-asset position is actually
 * *cleaner* — its health factor is independent of the LINK price, so the Guardian
 * sizes the rescue with no oracle at all.
 *
 * Steps (each simulated, then broadcast + confirmed before the next):
 *   1. faucet-mint LINK (enough to supply as collateral AND repay later)
 *   2. approve the Aave Pool to pull LINK
 *   3. supply LINK as collateral
 *   4. borrow LINK up to ~97% of capacity → HF lands just above 1.0
 *
 * Run:  npm run setup-position -- --dry-run   (simulate the mint/approve steps)
 *       npm run setup-position               (execute for real)
 */
import "../src/net.js";
import { loadConfig } from "../src/config.js";
import { KeeperHub } from "../src/keeperhub.js";
import { SEPOLIA_POOL, SEPOLIA_FAUCET, SEPOLIA_RESERVES, VARIABLE_RATE_MODE, toBaseUnits } from "../src/agent/assets.js";

const LINK = SEPOLIA_RESERVES.LINK;
const SUPPLY_LINK = 100; // collateral to supply
// The rescue repays from the wallet, so the mint + Pool approval must cover the
// collateral (transferred out at supply) AND the wallet balance the rescue repays
// from. With HF ~1.0 and target 1.5 the repay is ~⅓ of debt; 300 leaves a margin.
const MINT_LINK = 300; // faucet-mint: collateral + rescue-repay buffer
const APPROVE_LINK = MINT_LINK; // pool allowance covers supply + rescue repay
const BORROW_FRACTION = 0.97; // borrow 97% of capacity → low HF, below threshold

const cfg = loadConfig();
const kh = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
const dryRun = process.argv.includes("--dry-run");
const user = cfg.walletAddress;
const chainId = cfg.chainId;

async function main(): Promise<void> {
  console.log(`Setting up demo position for ${user} on chain ${chainId}${dryRun ? " (DRY RUN)" : ""}`);

  // 1. Mint LINK (collateral + a buffer for the later rescue repay).
  await step("Mint 200 LINK (faucet)", "contract-call", {
    chainId,
    contractAddress: SEPOLIA_FAUCET,
    functionName: "mint",
    functionArgs: JSON.stringify([LINK.address, user, toBaseUnits(LINK, MINT_LINK)]),
  });

  // 2. Approve the pool to pull our LINK (cover supply + the later rescue repay).
  await step("Approve Pool for LINK", "contract-call", {
    chainId,
    contractAddress: LINK.address,
    functionName: "approve",
    functionArgs: JSON.stringify([SEPOLIA_POOL, toBaseUnits(LINK, APPROVE_LINK)]),
  });

  // 3. Supply LINK as collateral.
  await step("Supply LINK collateral", "aave-v3/supply", {
    chainId,
    asset: LINK.address,
    amount: toBaseUnits(LINK, SUPPLY_LINK),
    onBehalfOf: user,
    referralCode: "0",
  });

  if (dryRun) {
    console.log("\nDry run complete — mint/approve/supply all simulate clean.");
    console.log("(Borrow amount depends on live capacity; run for real to open the position.)");
    return;
  }

  // 4. Read capacity, then borrow up to BORROW_FRACTION of it.
  const pos = await kh.readAavePosition(chainId, user);
  console.log(`\nAfter supply: collateral $${pos.totalCollateralUsd.toFixed(2)}, available borrows $${pos.availableBorrowsUsd.toFixed(2)}`);

  // Convert the USD borrow capacity to LINK using the position's own implied price
  // (collateralUsd / collateralTokens) — no external oracle needed.
  const collReserve = await kh.readUserReserve(chainId, LINK.address, user);
  const collTokens = Number(collReserve.aTokenBalance) / 10 ** LINK.decimals;
  if (!Number.isFinite(collTokens) || collTokens <= 0) {
    throw new Error("No LINK collateral found after supply — aborting before borrow.");
  }
  const linkUsd = pos.totalCollateralUsd / collTokens;
  if (!Number.isFinite(linkUsd) || linkUsd <= 0) {
    throw new Error(`Implied LINK price is invalid ($${linkUsd}) — aborting before borrow.`);
  }
  const borrowUsd = pos.availableBorrowsUsd * BORROW_FRACTION;
  const borrowLink = borrowUsd / linkUsd;
  if (!Number.isFinite(borrowLink) || borrowLink <= 0) {
    throw new Error(`Computed borrow amount is invalid (${borrowLink} LINK) — aborting.`);
  }
  console.log(`Borrowing ${borrowLink.toFixed(4)} LINK (~$${borrowUsd.toFixed(2)}, ${(BORROW_FRACTION * 100).toFixed(0)}% of capacity)…`);

  await step("Borrow LINK to the edge", "aave-v3/borrow", {
    chainId,
    asset: LINK.address,
    amount: toBaseUnits(LINK, borrowLink),
    interestRateMode: VARIABLE_RATE_MODE,
    referralCode: "0",
    onBehalfOf: user,
  });

  // 5. Show the resulting at-risk position.
  const after = await kh.readAavePosition(chainId, user);
  console.log(`\n✅ Position open. Health factor now ${fmtHf(after.healthFactor)} (threshold ${cfg.hfThreshold}).`);
  console.log(`   Run 'npm run guardian' to watch the Guardian rescue it.`);
}

main().catch((err) => {
  console.error("\nsetup-position failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

function fmtHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(4) : "∞";
}

/** Simulate a call; if clean and not a dry run, broadcast and wait for confirmation. */
async function step(
  label: string,
  actionType: string,
  body: Record<string, unknown>,
): Promise<void> {
  console.log(`\n▶ ${label}`);
  const sim = await kh.executeAction(actionType, body, { simulate: true });
  if (!sim.success) throw new Error(`  simulate failed: ${sim.error}`);
  console.log("  simulate: clean");
  if (dryRun) return;
  // Broadcast can transiently fail (rate limit / upstream blip); retry once.
  let exec;
  try {
    exec = await kh.executeAction(actionType, body);
  } catch (err) {
    console.log(`  execute threw (${err instanceof Error ? err.message : err}) — retrying once…`);
    exec = await kh.executeAction(actionType, body);
  }
  if (!exec.success) throw new Error(`  execute failed: ${exec.error}`);
  console.log(`  broadcast: ${exec.transactionLink ?? exec.transactionHash ?? "(sent)"}`);
  const anyExec = exec as unknown as { executionId?: string };
  if (anyExec.executionId) {
    // Confirmation is best-effort here: the broadcast already succeeded; a slow
    // mempool or a status-poll hiccup must not abort the rest of the setup.
    try {
      const final = await kh.waitForExecution(anyExec.executionId, { timeoutMs: 30_000 });
      console.log(`  status: ${final.status ?? "?"}`);
    } catch (err) {
      console.log(`  (status poll unfinished: ${err instanceof Error ? err.message : err})`);
    }
  }
}

