import { normalizeExecutionStatus, receiptFromRpc, verifyReceiptEvent, gasCostWei } from "../src/verification.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const pool = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const asset = "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5";
const user = "0x88678C9ae3798Aa77c753C3a6a028FE9FA5f7E3E";
const otherUser = "0x1111111111111111111111111111111111111111";
const repayTopic = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";
const supplyTopic = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
const amount = 257821958645241734690n;
const word = (value: bigint | string): string => (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).padStart(64, "0");
const topic = (addr: string): string => `0x${addr.slice(2).padStart(64, "0")}`;

// ── Repay: topics [sig, reserve, user(owner), repayer]; data [amount][useATokens] ─
const repayReceipt = receiptFromRpc({ status: "0x1", blockNumber: "0x10", gasUsed: "0x10", effectiveGasPrice: "0x2", logs: [{ address: pool, topics: [repayTopic, topic(asset), topic(user), topic(user)], data: `0x${word(amount)}${"0".repeat(64)}` }] }, "0xabc");
const repayEvent = verifyReceiptEvent(repayReceipt, { action: "repay", asset, user, amountUnits: amount, pool });
assert(repayEvent.matched, repayEvent.reason ?? "repay event did not match");
assert(repayEvent.amountUnits === amount.toString(), "repay amount was not decoded from data word 0");
assert(gasCostWei(repayReceipt) === "32", "gas cost was not calculated with bigint arithmetic");
assert(normalizeExecutionStatus({ status: "completed", transactionHash: "0xabc" }, "run").status === "confirmed", "completed status was not confirmed");
assert(normalizeExecutionStatus({ status: "cancelled" }, "run").status === "failed", "cancelled status was not failed");
assert(normalizeExecutionStatus({ status: "running" }, "run").status === "pending", "running status was not pending");

// ── Supply: topics [sig, reserve, onBehalfOf(owner), referralCode]; data [user][amount] ─
// (user is NOT indexed in Aave v3 Supply — the owner is onBehalfOf at topic 2.)
const supplyAmount = 42_000_000_000n;
const supplier = "0x2222222222222222222222222222222222222222"; // KeeperHub relay wallet
const supplyReceipt = receiptFromRpc({ status: "0x1", blockNumber: "0x11", gasUsed: "0x10", effectiveGasPrice: "0x2", logs: [{ address: pool, topics: [supplyTopic, topic(asset), topic(user), "0x".padEnd(64, "0")], data: `0x${word(supplier)}${word(supplyAmount)}` }] }, "0xdef");
const supplyEvent = verifyReceiptEvent(supplyReceipt, { action: "supply", asset, user, amountUnits: supplyAmount, pool });
assert(supplyEvent.matched, supplyEvent.reason ?? "supply event did not match");
assert(supplyEvent.user === user.toLowerCase(), "supply owner must come from onBehalfOf (topic 2)");
assert(supplyEvent.amountUnits === supplyAmount.toString(), "supply amount must come from data word 1, not the (non-indexed) user word");

// ── Negative cases: every mismatch must be reported, never silently confirmed ──
const wrongAmount = verifyReceiptEvent(repayReceipt, { action: "repay", asset, user, amountUnits: amount + 1n, pool });
assert(!wrongAmount.matched && /amount does not match/.test(wrongAmount.reason ?? ""), `wrong amount: ${wrongAmount.reason}`);
const wrongReserve = verifyReceiptEvent(repayReceipt, { action: "repay", asset: "0x" + "a".repeat(40), user, amountUnits: amount, pool });
assert(!wrongReserve.matched && /reserve does not match/.test(wrongReserve.reason ?? ""), `wrong reserve: ${wrongReserve.reason}`);
const wrongUser = verifyReceiptEvent(repayReceipt, { action: "repay", asset, user: otherUser, amountUnits: amount, pool });
assert(!wrongUser.matched && /user does not match/.test(wrongUser.reason ?? ""), `wrong user: ${wrongUser.reason}`);
const wrongAction = verifyReceiptEvent(repayReceipt, { action: "supply", asset, user, amountUnits: amount, pool });
assert(!wrongAction.matched && /No Supply event found/.test(wrongAction.reason ?? ""), `wrong action: ${wrongAction.reason}`);
const wrongPool = verifyReceiptEvent(repayReceipt, { action: "repay", asset, user, amountUnits: amount, pool: "0x" + "b".repeat(40) });
assert(!wrongPool.matched && /No Repay event found/.test(wrongPool.reason ?? ""), `wrong pool: ${wrongPool.reason}`);

console.log("Transaction verification tests passed.");
