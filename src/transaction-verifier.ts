import { rpc } from "../server/rescues.js";
import { gasCostWei, receiptFromRpc, verifyReceiptEvent, type RescueExpectation, type SettlementVerification } from "./verification.js";

export async function verifyTransaction(input: { txHash: string; expected: RescueExpectation; timeoutMs?: number; intervalMs?: number }): Promise<SettlementVerification> {
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  const intervalMs = input.intervalMs ?? 2_000;
  while (Date.now() < deadline) {
    try {
      const raw = await rpc("eth_getTransactionReceipt", [input.txHash]);
      if (raw && typeof raw === "object") {
        const receipt = receiptFromRpc(raw as Record<string, unknown>, input.txHash);
        const cost = gasCostWei(receipt);
        if (receipt.status !== 1) return { status: "reverted", receipt, gasCostWei: cost, reason: "Transaction receipt status is 0." };
        const event = verifyReceiptEvent(receipt, input.expected);
        if (!event.matched) return { status: "verification_failed", receipt, event, gasCostWei: cost, reason: event.reason };
        return { status: "confirmed", receipt, event, gasCostWei: cost };
      }
    } catch {
      // A flaky RPC read or a malformed receipt must not crash the rescue
      // reporting — keep polling until the deadline and surface `pending`.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: "pending", reason: `Receipt ${input.txHash} was not available before the timeout.` };
}

export function txHashFrom(value: { transactionHash?: string; transactionLink?: string }): string | undefined {
  if (value.transactionHash) return value.transactionHash;
  return value.transactionLink?.match(/0x[0-9a-fA-F]{64}/)?.[0];
}

export function verifyDemoTransaction(input: { txHash: string; expected: RescueExpectation }): Promise<SettlementVerification> {
  return verifyTransaction(input);
}

export function formatVerification(result: SettlementVerification): Record<string, unknown> {
  return { status: result.status, reason: result.reason, txHash: result.receipt?.transactionHash, blockNumber: result.receipt?.blockNumber, receiptStatus: result.receipt?.status, gasUsed: result.receipt?.gasUsed.toString(), gasCostWei: result.gasCostWei, event: result.event };
}
