import type { AuditEvent, AuditSink } from "../src/audit.js";
import { GuardianStore } from "./store.js";

export class RedisAuditSink implements AuditSink {
  constructor(private readonly store: GuardianStore, private readonly wallet: string) {}
  record(event: AuditEvent): Promise<void> {
    return this.store.appendAudit(this.wallet, event);
  }
}
