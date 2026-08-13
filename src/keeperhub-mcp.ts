import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type { ActionResult, ExecutionResult, SimulationResult } from "./keeperhub.js";

export interface KeeperHubMcpConfig {
  apiKey: string;
  url: string;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function redact(value: unknown): string {
  return String(value).replace(/kh_[A-Za-z0-9_\-+/=.]+/g, "kh_[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function resultValue(result: McpToolResult): Record<string, unknown> {
  if (result.isError) {
    const text = result.content?.map((item) => item.text ?? "").join(" ").trim() || "MCP tool failed";
    throw new Error(redact(text));
  }
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.map((item) => item.text ?? "").join("\n").trim();
  if (!text) return result as Record<string, unknown>;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { text }; }
}

export class KeeperHubMcpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(config: KeeperHubMcpConfig) {
    if (!config.apiKey.startsWith("kh_")) throw new Error("KeeperHub API key must be kh_-prefixed.");
    if (!config.url.startsWith("https://")) throw new Error("KeeperHub MCP URL must use HTTPS.");
    this.client = new Client({ name: "liquidation-guardian", version: "0.1.0" });
    this.transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.apiKey}` } } });
  }

  async connect(): Promise<void> {
    if (!this.connected) { await this.client.connect(this.transport); this.connected = true; }
  }

  async close(): Promise<void> {
    if (this.connected) { await this.client.close(); this.connected = false; }
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    return resultValue(await this.client.callTool({ name, arguments: args }) as McpToolResult);
  }

  async simulateAction(actionType: string, params: Record<string, unknown>): Promise<SimulationResult> {
    const raw = await this.callTool("execute_protocol_action", { actionType, params: { ...params, simulate: true } });
    return normalizeSimulation(raw);
  }

  async executeAction(actionType: string, params: Record<string, unknown>, idempotencyKey = randomUUID()): Promise<ExecutionResult> {
    const raw = await this.callTool("execute_protocol_action", { actionType, params: { ...params, idempotency_key: idempotencyKey } });
    return normalizeExecution(raw);
  }

  async getExecution(executionId: string): Promise<Record<string, unknown>> {
    return this.callTool("get_direct_execution_status", { execution_id: executionId });
  }

  async searchProtocolActions(query: string): Promise<Record<string, unknown>> {
    return this.callTool("search_protocol_actions", { query, protocol: "aave-v3" });
  }
}

function normalizeSimulation(raw: Record<string, unknown>): SimulationResult {
  return {
    success: raw.success === true,
    status: String(raw.status ?? "unknown"),
    from: String(raw.from ?? ""),
    to: String(raw.to ?? ""),
    value: String(raw.value ?? "0"),
    gasEstimate: String(raw.gasEstimate ?? raw.gas_estimate ?? "0"),
    wouldRevert: raw.wouldRevert === true || raw.would_revert === true,
    simulatedReturnValue: raw.simulatedReturnValue == null ? null : String(raw.simulatedReturnValue),
  };
}

function normalizeExecution(raw: Record<string, unknown>): ExecutionResult {
  const executionId = String(raw.executionId ?? raw.execution_id ?? "");
  if (!executionId) throw new Error("MCP execution did not return an execution ID.");
  return {
    executionId,
    status: String(raw.status ?? "running"),
    transactionHash: String(raw.transactionHash ?? raw.transaction_hash ?? ""),
    transactionLink: String(raw.transactionLink ?? raw.transaction_link ?? ""),
  };
}

export function normalizeMcpActionResult(raw: Record<string, unknown>): ActionResult {
  return { success: raw.success === true, result: raw.result as Record<string, unknown> | undefined, error: raw.error == null ? undefined : redact(raw.error) };
}
