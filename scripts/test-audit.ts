import { MemoryAuditSink, auditEvent, safeAudit } from "../src/audit.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const event = auditEvent({ runId: "run-1", phase: "decision", source: "cli", chainId: "11155111", wallet: "0xabc", reasoning: "Bearer kh_secret should be hidden", error: "kh_secret" });
assert(!JSON.stringify(event).includes("kh_secret"), "audit event leaked a credential");
const sink = new MemoryAuditSink();
await safeAudit(sink, event);
assert(sink.events.length === 1, "audit event was not stored");
console.log("Audit redaction tests passed.");
