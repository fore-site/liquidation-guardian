import { KeeperHub, type SimulationResult } from "./keeperhub.js";
import { KeeperHubMcpClient } from "./keeperhub-mcp.js";

type ActionResultLike = { success: boolean; executionId?: string; status?: string; transactionHash?: string; transactionLink?: string; error?: string };

export interface TransportSimulationResult extends Partial<SimulationResult> { success: boolean; error?: string; }
export interface TransportExecutionResult extends ActionResultLike {}

export interface ExecutionTransport {
  readonly name: "rest" | "mcp";
  simulateAction(actionType: string, body: Record<string, unknown>): Promise<TransportSimulationResult>;
  executeAction(actionType: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<TransportExecutionResult>;
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
}

export class McpExecutionTransport implements ExecutionTransport {
  readonly name = "mcp" as const;
  private readonly restPreflight: RestExecutionTransport;
  constructor(private readonly client: KeeperHubMcpClient, keeperHub: KeeperHub) {
    this.restPreflight = new RestExecutionTransport(keeperHub);
  }
  simulateAction(actionType: string, body: Record<string, unknown>) {
    return this.restPreflight.simulateAction(actionType, body);
  }
  async executeAction(actionType: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<TransportExecutionResult> {
    const result = await this.client.executeAction(actionType, body, idempotencyKey as `${string}-${string}-${string}-${string}-${string}` | undefined);
    return { success: true, executionId: result.executionId, status: result.status, transactionHash: result.transactionHash, transactionLink: result.transactionLink };
  }
}

export function createExecutionTransport(input: { transport?: "rest" | "mcp"; keeperHub: KeeperHub; mcp?: KeeperHubMcpClient }): ExecutionTransport {
  if (input.transport !== "mcp") return new RestExecutionTransport(input.keeperHub);
  if (!input.mcp) throw new Error("MCP transport selected but no MCP client was configured.");
  return new McpExecutionTransport(input.mcp, input.keeperHub);
}
