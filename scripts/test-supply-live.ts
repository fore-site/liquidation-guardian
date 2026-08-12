/**
 * Live supply-side end-to-end verification (network required).
 *
 * Finds the most recent real Aave v3 `Supply` event on the Sepolia Pool,
 * decodes the expectations straight from the log using the canonical ABI
 * (aave-v3-core IPool.sol — `Supply(address indexed reserve, address user,
 * address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)`,
 * so the owner is `onBehalfOf` at topic 2 and the amount is the SECOND data
 * word), then runs the SAME verifier used in production
 * (src/transaction-verifier.ts) against that transaction's receipt.
 *
 * A +1-wei control proves the amount path is genuinely exercised live.
 *
 * Run:  npm run test-supply-live
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { rpc } from "../server/rescues.js";
import { SEPOLIA_POOL } from "../src/agent/assets.js";
import { verifyTransaction } from "../src/transaction-verifier.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
const MAX_RANGE = 49_000;

function topicToAddress(topic: string): string {
  return "0x" + topic.replace(/^0x/, "").slice(24).toLowerCase();
}

// Find the newest Supply event in the last full public-RPC window (~2 days of
// Sepolia blocks — plenty of testnet activity).
const latestRaw = await rpc("eth_blockNumber", []);
const latest = parseInt(String(latestRaw), 16);
const from = latest - MAX_RANGE;
const logs = await rpc("eth_getLogs", [
  {
    address: SEPOLIA_POOL,
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + latest.toString(16),
    topics: [SUPPLY_TOPIC],
  },
]);
if (!Array.isArray(logs) || logs.length === 0) {
  throw new Error("No Supply events found in the last 49k Sepolia blocks — retry later.");
}
const log = logs[logs.length - 1] as { transactionHash: string; topics: string[]; data: string; blockNumber: string };
const txHash = log.transactionHash;
const asset = topicToAddress(log.topics[1]); // reserve
const owner = topicToAddress(log.topics[2]); // onBehalfOf — the position owner
const data = log.data.replace(/^0x/, "");
// Supply data = [user (non-indexed)][amount] — the amount is the second word.
const amountUnits = BigInt("0x" + (data.slice(64, 128) || "0"));

console.log(`Live Supply tx ${txHash} (block ${parseInt(log.blockNumber, 16)}):`);
console.log(`  reserve ${asset} · onBehalfOf ${owner} · amount ${amountUnits}`);

const verified = await verifyTransaction({
  txHash,
  expected: { action: "supply", asset, user: owner, amountUnits },
});
assert(
  verified.status === "confirmed",
  `live supply should confirm, got ${verified.status}: ${verified.reason ?? verified.event?.reason}`,
);
console.log(
  `  ✅ receipt confirmed (status ${verified.receipt?.status}, gas ${verified.receipt?.gasUsed}, event ${verified.event?.event})`,
);

// Control: off-by-one wei must be rejected — proves the amount check is live.
const negative = await verifyTransaction({
  txHash,
  expected: { action: "supply", asset, user: owner, amountUnits: amountUnits + 1n },
});
assert(
  negative.status === "verification_failed" && /amount does not match/.test(negative.reason ?? ""),
  `+1 wei control should be verification_failed, got ${negative.status}: ${negative.reason}`,
);
console.log(`  ✅ +1 wei control → verification_failed ("${negative.reason}")`);

console.log("\nLive Supply verification tests passed.");
