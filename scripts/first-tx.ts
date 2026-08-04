/**
 * "Hello, onchain" — the smallest possible proof that KeeperHub executes for you.
 *
 * Simulates a tiny native transfer, and (unless --dry-run) broadcasts it. This is
 * the first thing to run with a fresh KeeperHub key: it confirms your wallet is
 * provisioned, gas is sponsored, and you can read a real tx hash back — before you
 * touch Aave. The verified run of this is written up in docs/FIRST_TX.md.
 *
 * Run:  npm run first-tx -- --dry-run     (simulate only, no broadcast)
 *       npm run first-tx                  (simulate, then broadcast)
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { loadConfig } from "../src/config.js";
import { KeeperHub } from "../src/keeperhub.js";

const cfg = loadConfig();
const keeperHub = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
const dryRun = process.argv.includes("--dry-run");

// Send a dust amount to ourselves — safe, and it still exercises the full path.
const transfer = {
  chainId: cfg.chainId,
  recipientAddress: cfg.walletAddress,
  amount: "0.0001",
};

console.log(`\nStep 1 — simulate transfer of ${transfer.amount} to ${transfer.recipientAddress}…`);
const sim = await keeperHub.simulateTransfer(transfer);
console.log(`  success=${sim.success}  wouldRevert=${sim.wouldRevert}  gasEstimate=${sim.gasEstimate}`);

if (!sim.success || sim.wouldRevert) {
  console.error("  Simulation not clean — aborting before broadcast.");
  process.exit(1);
}

if (dryRun) {
  console.log("\n--dry-run: simulation clean, not broadcasting. Drop the flag to send for real.\n");
  process.exit(0);
}

console.log("\nStep 2 — broadcasting…");
const exec = await keeperHub.executeTransfer(transfer);
console.log(`  executionId : ${exec.executionId}`);
console.log(`  status      : ${exec.status}`);
console.log(`  tx hash     : ${exec.transactionHash}`);
console.log(`  tx link     : ${exec.transactionLink}`);
console.log("\n✅ KeeperHub executed a real transaction for you. Save that link.\n");
