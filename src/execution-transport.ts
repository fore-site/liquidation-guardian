import { KeeperHub, type SimulationResult } from "./keeperhub.js";
import { KeeperHubMcpClient } from "./keeperhub-mcp.js";
import { normalizeExecutionStatus, type NormalizedExecutionStatus } from "./verification.js";

type ActionResultLike = { success: boolean; executionId?: string; status?: string; transactionHash?: string; transactionLink?: string; error?: string };

export interface TransportSimulationResult extends Partial<SimulationResult> { success: boolean; error?: string; }
export interface TransportExecutionResult extends ActionResultLike {}

export interface ExecutionTransport {
  readonly name: "rest" | "mcp";
  simulateAction(actionType: string, body: Record<string, unknown>): Promise<TransportSimulationResult>;
  executeAction(actionType: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<TransportExecutionResult>;
  waitForExecution(executionId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<NormalizedExecutionStatus>;
}

export class RestExecutionTransport implements ExecutionTransport {
  readonly name = "rest" as const;
  constructor(private readonly keeperHub: KeeperHub) {}
  async simulateAction(actionType: string, body: Record<string, unknown>): Promise<TransportSimulationResult> {
    const result = await this.keeperHub.executeAction(actionType, body, { simulate: true });
    const raw = result.result as Record<string, unknown> | undefined;
    return { success: result.success, error: result.error, gasEstimate: raw?.gasEstimate == null ? undefined : String(raw.gasEstimate), wouldRevert: raw?.wouldRevert === true };
  }
  async executeAction(actionType: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<TransportExecutionResult> {
    const result = await this.keeperHub.executeAction(actionType, body, { idempotencyKey });
    const raw = result as ActionResultLike;
    return { success: raw.success, executionId: raw.executionId, status: raw.status, transactionHash: raw.transactionHash, transactionLink: raw.transactionLink, error: raw.error };
  }
  async waitForExecution(executionId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<NormalizedExecutionStatus> {
    try {
      const raw = await this.keeperHub.waitForExecution(executionId, opts);
      return normalizeExecutionStatus(raw, executionId);
    } catch (err) {
      // keeperHub.waitForExecution throws when the deadline passes without a
      // terminal state — surface that as `pending` (not a crash) so executeRescue
      // reports broadcast_pending, matching the MCP transport's behavior.
      return {
        status: "pending",
        executionId,
        error: err instanceof Error ? err.message : String(err),
        raw: {},
      };
    }
  }
}

export class McpExecutionTransport implements ExecutionTransport {
  readonly name = "mcp" as const;
  private readonly restPreflight: RestExecutionTransport;
  constructor(private readonly client: KeeperHubMcpClient, keeperHub: KeeperHub) { this.restPreflight = new RestExecutionTransport(keeperHub); }
  simulateAction(actionType: string, body: Record<string, unknown>) { return this.restPreflight.simulateAction(actionType, body); }
  async executeAction(actionType: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<TransportExecutionResult> {
    const result = await this.client.executeAction(actionType, body, idempotencyKey as `${string}-${string}-${string}-${string}-${string}` | undefined);
    return { success: true, executionId: result.executionId, status: result.status, transactionHash: result.transactionHash, transactionLink: result.transactionLink };
  }
  async waitForExecution(executionId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<NormalizedExecutionStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    const intervalMs = opts.intervalMs ?? 2_000;
    let last: NormalizedExecutionStatus = { status: "pending", executionId, raw: {} };
    while (Date.now() < deadline) {
      try {
        last = normalizeExecutionStatus(await this.client.getExecution(executionId), executionId);
      } catch (err) {
        // A flaky status read must not abort the wait — keep polling (same as
        // the REST transport's tolerance for transient status-read failures).
        last = { status: "pending", executionId, error: err instanceof Error ? err.message : String(err), raw: {} };
      }
      if (last.status !== "pending") return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return last;
  }
}

export function createExecutionTransport(input: { transport?: "rest" | "mcp"; keeperHub: KeeperHub; mcp?: KeeperHubMcpClient }): ExecutionTransport {
  if (input.transport !== "mcp") return new RestExecutionTransport(input.keeperHub);
  if (!input.mcp) throw new Error("MCP transport selected but no MCP client was configured.");
  return new McpExecutionTransport(input.mcp, input.keeperHub);
}
