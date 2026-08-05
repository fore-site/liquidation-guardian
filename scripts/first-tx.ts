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

async function main(): Promise<void> {
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
    return;
  }

  console.log("\nStep 2 — broadcasting…");
  const exec = await keeperHub.executeTransfer(transfer);
  console.log(`  executionId : ${exec.executionId}`);
  console.log(`  status      : ${exec.status}`);
  console.log(`  tx hash     : ${exec.transactionHash}`);
  console.log(`  tx link     : ${exec.transactionLink}`);

  // Wait for the broadcast to reach a terminal state so "it worked" actually means
  // the tx confirmed — not just that the API accepted it.
  if (exec.executionId) {
    const final = await keeperHub.waitForExecution(exec.executionId);
    const status = String(final.status ?? "").toLowerCase();
    if (!["success", "confirmed"].includes(status)) {
      console.error(`  ⚠️  Broadcast accepted but final status is "${final.status ?? "unknown"}" — check the link above.`);
      process.exit(1);
    }
    console.log(`  final status: ${final.status}`);
  }

  console.log("\n✅ KeeperHub executed a real transaction for you. Save that link.\n");
}

main().catch((err) => {
  console.error("\nfirst-tx failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
