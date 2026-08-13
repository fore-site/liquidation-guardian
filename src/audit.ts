import { randomUUID } from "node:crypto";

export type AuditSource = "cli" | "event-watcher" | "telegram" | "mcp" | "dashboard";
export type AuditPhase = "trigger" | "decision" | "approval" | "simulation" | "broadcast" | "confirmation" | "failed";

export interface AuditEvent {
  runId: string;
  phase: AuditPhase;
  source: AuditSource;
  at: string;
  chainId: string;
  wallet: string;
  transport?: "rest" | "mcp";
  dryRun?: boolean;
  healthFactorBefore?: number;
  healthFactorAfter?: number;
  threshold?: number;
  target?: number;
  provider?: "llm" | "deterministic";
  action?: "repay" | "supply";
  asset?: string;
  amountHuman?: number;
  amountUnits?: string;
  reasoning?: string;
  status?: string;
  success?: boolean;
  wouldRevert?: boolean;
  gasEstimate?: string;
  executionId?: string;
  transactionHash?: string;
  transactionLink?: string;
  error?: string;
}

export interface AuditSink { record(event: AuditEvent): Promise<void>; }

export function newAuditRunId(): string { return randomUUID(); }

export function auditEvent(input: Omit<AuditEvent, "at">): AuditEvent {
  return { ...input, at: new Date().toISOString(), reasoning: input.reasoning ? redact(input.reasoning) : undefined, error: input.error ? redact(input.error) : undefined };
}

// Superset of the onboarding validator (web/src/server/api.ts) — must catch
// every plausible key encoding (base64url, standard base64, dotted tokens) so a
// future key format can never leak into logs. Over-redaction here is harmless.
function redact(value: string): string {
  return value.replace(/kh_[A-Za-z0-9_\-+/=.]+/g, "kh_[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export async function safeAudit(sink: AuditSink | undefined, event: Omit<AuditEvent, "at">): Promise<void> {
  if (!sink) return;
  try { await sink.record(auditEvent(event)); } catch { /* audit must never block execution */ }
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> { this.events.push(event); }
}
