/**
 * Live negative-case gate for the onchain verifier (network required).
 *
 * Runs the SAME verifier used in production (src/transaction-verifier.ts)
 * against the recorded, independently-verified demo rescue transaction from
 * docs/RESCUE_TX.md. It asserts the exact match confirms — and every drifted
 * expectation (wrong amount, wrong asset, wrong user, wrong action) is
 * rejected as `verification_failed` with a reason, never silently confirmed.
 *
 * Run:  npm run test-verify-negative
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { verifyDemoTransaction } from "../src/transaction-verifier.js";
import type { RescueExpectation } from "../src/verification.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The recorded, verified demo rescue (docs/RESCUE_TX.md) — receipt status 1,
// block 11475458, exact Aave Repay event match. The tx is fixed, so its owner
// is hardcoded too — the test is self-contained and unaffected by WALLET_ADDRESS
// in .env.
const DEMO_TX = "0x3b056fd69281dfdc4413094684983604046b66902f77cfe88e8d5da960aa88b9";
const DEMO_ACTION = "repay";
const DEMO_ASSET = "0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5"; // LINK (Sepolia)
const DEMO_USER = "0x88678c9ae3798aa77c753c3a6a028fe9fa5f7e3e"; // position owner
const DEMO_AMOUNT = 257821958645241734690n;
const OTHER_USER = "0x1111111111111111111111111111111111111111";

const expected: RescueExpectation = {
  action: DEMO_ACTION,
  asset: DEMO_ASSET,
  user: DEMO_USER,
  amountUnits: DEMO_AMOUNT,
};

console.log(`Verifying live tx ${DEMO_TX} against ${DEMO_USER}…`);

// Control: the exact expectations must confirm.
const control = await verifyDemoTransaction({ txHash: DEMO_TX, expected });
assert(
  control.status === "confirmed",
  `control should confirm, got ${control.status}: ${control.reason ?? control.event?.reason}`,
);
console.log(`  ✅ exact match → confirmed (block ${control.receipt?.blockNumber}, event ${control.event?.event})`);

// Wrong amount: off by one wei must be rejected.
const wrongAmount = await verifyDemoTransaction({
  txHash: DEMO_TX,
  expected: { ...expected, amountUnits: DEMO_AMOUNT + 1n },
});
assert(
  wrongAmount.status === "verification_failed" && /amount does not match/.test(wrongAmount.reason ?? ""),
  `wrong amount should be verification_failed, got ${wrongAmount.status}: ${wrongAmount.reason}`,
);
console.log(`  ✅ wrong amount (+1 wei) → verification_failed ("${wrongAmount.reason}")`);

// Wrong asset: a different reserve must be rejected.
const wrongAsset = await verifyDemoTransaction({
  txHash: DEMO_TX,
  expected: { ...expected, asset: "0x" + "a".repeat(40) },
});
assert(
  wrongAsset.status === "verification_failed" && /reserve does not match/.test(wrongAsset.reason ?? ""),
  `wrong asset should be verification_failed, got ${wrongAsset.status}: ${wrongAsset.reason}`,
);
console.log(`  ✅ wrong asset → verification_failed ("${wrongAsset.reason}")`);

// Wrong user: another wallet must be rejected.
const wrongUser = await verifyDemoTransaction({
  txHash: DEMO_TX,
  expected: { ...expected, user: OTHER_USER },
});
assert(
  wrongUser.status === "verification_failed" && /user does not match/.test(wrongUser.reason ?? ""),
  `wrong user should be verification_failed, got ${wrongUser.status}: ${wrongUser.reason}`,
);
console.log(`  ✅ wrong user → verification_failed ("${wrongUser.reason}")`);

// Wrong action: asking for a Supply event against a Repay tx must be rejected.
const wrongAction = await verifyDemoTransaction({
  txHash: DEMO_TX,
  expected: { ...expected, action: "supply" },
});
assert(
  wrongAction.status === "verification_failed" && /No Supply event found/.test(wrongAction.reason ?? ""),
  `wrong action should be verification_failed, got ${wrongAction.status}: ${wrongAction.reason}`,
);
console.log(`  ✅ wrong action → verification_failed ("${wrongAction.reason}")`);

console.log("\nLive negative-case verification tests passed.");
