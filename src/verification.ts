import { SEPOLIA_POOL, SEPOLIA_RESERVES } from "./agent/assets.js";

export type SettlementStatus = "pending" | "confirmed" | "reverted" | "failed" | "unknown";

export interface NormalizedExecutionStatus {
  status: SettlementStatus;
  executionId: string;
  transactionHash?: string;
  transactionLink?: string;
  error?: string;
  gasUsedWei?: string;
  sponsored?: boolean;
  raw: Record<string, unknown>;
}

export interface Receipt {
  transactionHash: string;
  blockNumber: number;
  status: 0 | 1;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  from?: string;
  to?: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface RescueExpectation {
  action: "repay" | "supply";
  asset: string;
  user: string;
  amountUnits: bigint;
  pool?: string;
}

export interface EventVerification {
  matched: boolean;
  event: "Repay" | "Supply";
  transactionHash: string;
  asset?: string;
  user?: string;
  amountUnits?: string;
  blockNumber?: number;
  reason?: string;
}

export interface SettlementVerification {
  status: SettlementStatus | "verification_failed";
  receipt?: Receipt;
  event?: EventVerification;
  gasCostWei?: string;
  reason?: string;
}

const REPAY_TOPIC = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";
const SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
const TERMINAL_SUCCESS = new Set(["success", "completed", "confirmed"]);
const TERMINAL_FAILURE = new Set(["failed", "reverted", "error", "cancelled", "canceled", "dropped", "expired"]);

export function normalizeExecutionStatus(raw: Record<string, unknown>, executionId: string): NormalizedExecutionStatus {
  const value = String(raw.status ?? "unknown").toLowerCase();
  const status: SettlementStatus = TERMINAL_SUCCESS.has(value) ? "confirmed" : TERMINAL_FAILURE.has(value) ? (value === "reverted" ? "reverted" : "failed") : "pending";
  return { status, executionId, transactionHash: stringValue(raw.transactionHash ?? raw.transaction_hash), transactionLink: stringValue(raw.transactionLink ?? raw.transaction_link), error: stringValue(raw.error), gasUsedWei: stringValue(raw.gasUsedWei ?? raw.gas_used_wei), sponsored: raw.sponsored === true, raw };
}

export function receiptFromRpc(raw: Record<string, unknown>, transactionHash: string): Receipt {
  const status = raw.status === "0x1" ? 1 : raw.status === "0x0" ? 0 : -1;
  if (status < 0) throw new Error("Transaction receipt has no valid status.");
  const logs = Array.isArray(raw.logs) ? raw.logs.map((log) => log as { address: string; topics: string[]; data: string }) : [];
  return { transactionHash, blockNumber: parseInt(String(raw.blockNumber ?? "0"), 16), status: status as 0 | 1, gasUsed: BigInt(String(raw.gasUsed ?? "0x0")), effectiveGasPrice: raw.effectiveGasPrice ? BigInt(String(raw.effectiveGasPrice)) : undefined, from: stringValue(raw.from), to: stringValue(raw.to), logs };
}

export function verifyReceiptEvent(receipt: Receipt, expected: RescueExpectation): EventVerification {
  const topic = expected.action === "repay" ? REPAY_TOPIC : SUPPLY_TOPIC;
  const log = receipt.logs.find((item) => item.address.toLowerCase() === (expected.pool ?? SEPOLIA_POOL).toLowerCase() && item.topics[0]?.toLowerCase() === topic);
  const event = expected.action === "repay" ? "Repay" : "Supply";
  if (!log) return { matched: false, event, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, reason: `No ${event} event found for the expected pool.` };
  const reserve = topicAddress(log.topics[1]);
  // Aave v3 indexed layout (verified against aave-v3-core IPool.sol):
  //   Repay(reserve, user, repayer, amount, useATokens)      — user (owner) at topic 2
  //   Supply(reserve, user, onBehalfOf, amount, referralCode) — onBehalfOf (owner)
  //     at topic 2 (user is NOT indexed; referralCode is indexed at topic 3).
  // So the position owner we compare against is always topic 2.
  const userTopic = topicAddress(log.topics[2]);
  const data = log.data.replace(/^0x/, "");
  // Data layout: Repay = [amount][useATokens]; Supply = [user][amount] — the
  // supplied/repayed `amount` is the FIRST data word for Repay and the SECOND
  // for Supply.
  const amount = expected.action === "repay" ? BigInt(`0x${data.slice(0, 64) || "0"}`) : BigInt(`0x${data.slice(64, 128) || "0"}`);
  if (reserve !== expected.asset.toLowerCase()) return { matched: false, event, transactionHash: receipt.transactionHash, asset: reserve, user: userTopic, amountUnits: amount.toString(), blockNumber: receipt.blockNumber, reason: "Event reserve does not match the expected asset." };
  if (userTopic !== expected.user.toLowerCase()) return { matched: false, event, transactionHash: receipt.transactionHash, asset: reserve, user: userTopic, amountUnits: amount.toString(), blockNumber: receipt.blockNumber, reason: "Event user does not match the expected wallet." };
  if (amount !== expected.amountUnits) return { matched: false, event, transactionHash: receipt.transactionHash, asset: reserve, user: userTopic, amountUnits: amount.toString(), blockNumber: receipt.blockNumber, reason: "Event amount does not match the expected base-unit amount." };
  return { matched: true, event, transactionHash: receipt.transactionHash, asset: reserve, user: userTopic, amountUnits: amount.toString(), blockNumber: receipt.blockNumber };
}

export function gasCostWei(receipt: Receipt): string | undefined {
  return receipt.effectiveGasPrice == null ? undefined : (receipt.gasUsed * receipt.effectiveGasPrice).toString();
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function topicAddress(topic: string | undefined): string { return `0x${String(topic ?? "").replace(/^0x/, "").slice(-40).toLowerCase()}`; }

export const LINK_ASSET = SEPOLIA_RESERVES.LINK.address;
