import type { AuditEvent } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

type Tone = "neutral" | "success" | "danger";

interface TimelineItem {
  key: string;
  label: string;
  tone: Tone;
  meta: string;
  detail?: string;
  /** User-facing explanation of a failure (mapped from the raw error). */
  reason?: string;
  /** The raw error string, shown under a friendly reason. */
  raw?: string;
  link?: string;
  time: string;
}

/**
 * A `failed` audit event always belongs to a step (simulation, broadcast, …).
 * Events are stored newest-first, so scan the *older* events of the same run to
 * find which step the failure happened in.
 */
function failedStepOf(event: AuditEvent, all: AuditEvent[]): string | null {
  const idx = all.indexOf(event);
  for (let i = idx + 1; i < all.length; i++) {
    const prev = all[i];
    if (prev.runId !== event.runId) continue;
    if (prev.phase === "simulation" || prev.phase === "broadcast" || prev.phase === "confirmation" || prev.phase === "decision") {
      return prev.phase;
    }
    if (prev.phase === "failed") break; // two failures in a row — no step marker between them
  }
  return null;
}

function fmtAmount(n?: number): string {
  return n != null && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "";
}

/** Turn a raw revert string into a user-facing explanation when one is known. */
function friendlyReason(e: AuditEvent): string | null {
  const err = e.error ?? "";
  if (!err) return null;
  const asset = e.asset?.toUpperCase() ?? "the asset";
  const action = e.action === "supply" ? "supply" : e.action === "repay" ? "repay" : "rescue";
  if (/allowance/i.test(err)) {
    return `Not enough approved: the wallet's ${asset} allowance to the Aave Pool is smaller than the ${action} amount. Approve more ${asset} to Aave, then retry.`;
  }
  if (/exceeds balance|insufficient balance|insufficient funds/i.test(err)) {
    return `Not enough balance: the wallet doesn't hold enough ${asset} for this ${action}.`;
  }
  if (/not enough liquidity|insufficient liquidity/i.test(err)) {
    return `Aave doesn't have enough ${asset} liquidity right now. Try again shortly, or pick a different lever.`;
  }
  return null;
}

function toItems(events: AuditEvent[]): TimelineItem[] {
  return events.map((event, index) => {
    const key = `${event.runId}-${event.phase}-${event.at}-${index}`;
    const meta = [event.source, event.transport].filter(Boolean).join(" · ");
    const time = new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const action =
      event.action === "repay" || event.action === "supply"
        ? `${event.action[0].toUpperCase()}${event.action.slice(1)} ${fmtAmount(event.amountHuman)} ${event.asset?.toUpperCase() ?? ""}`
        : undefined;
    const hf =
      event.healthFactorAfter != null
        ? `HF ${(event.healthFactorBefore ?? 0).toFixed(4)} → ${event.healthFactorAfter.toFixed(4)}`
        : event.healthFactorBefore != null
          ? `HF ${event.healthFactorBefore.toFixed(4)}`
          : undefined;
    const detail = [action, hf].filter(Boolean).join(" · ") || undefined;

    switch (event.phase) {
      case "simulation":
        return { key, label: event.success === true ? "Simulation passed" : "Simulation", tone: event.success === true ? "success" : "neutral", meta, detail, link: event.transactionLink, time };
      case "broadcast": {
        const status = String(event.status ?? "").toLowerCase();
        if (status === "reverted" || status === "failed" || status === "error") {
          return { key, label: "Transaction reverted", tone: "danger", meta, detail, reason: "The transaction was mined but reverted onchain — no position change.", link: event.transactionLink, time };
        }
        return { key, label: "Broadcast", tone: "neutral", meta, detail, link: event.transactionLink, time };
      }
      case "confirmation":
        return { key, label: "Confirmed onchain", tone: "success", meta, detail, link: event.transactionLink, time };
      case "approval": {
        const asset = event.asset?.toUpperCase();
        return { key, label: event.success === true ? (asset ? `Approved ${asset} to Aave Pool` : "Approval confirmed") : "Approval", tone: event.success === true ? "success" : "neutral", meta, detail, link: event.transactionLink, time };
      }
      case "failed": {
        const err = event.error ?? "";
        const status = String(event.status ?? "").toLowerCase();
        const step = failedStepOf(event, events);
        const label = /verification/i.test(err)
          ? "Verification failed"
          : status === "reverted"
            ? "Transaction reverted"
            : step === "simulation"
              ? "Simulation failed"
              : step === "broadcast"
                ? "Broadcast failed"
                : step === "confirmation"
                  ? "Confirmation failed"
                  : "Execution failed";
        const friendly = friendlyReason(event);
        return { key, label, tone: "danger", meta, detail, reason: friendly ?? (err || "The attempt failed before completing."), raw: friendly && err ? err : undefined, link: event.transactionLink, time };
      }
      default:
        return { key, label: event.phase.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), tone: "neutral", meta, detail, link: event.transactionLink, time };
    }
  });
}

export function AuditTimeline({ events, error, onRetry }: { events: AuditEvent[]; error?: boolean; onRetry: () => void }) {
  const items = toItems(events).slice(0, 8);
  return <Card><CardHeader><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Execution record</p><CardTitle>Guardian audit trail</CardTitle></CardHeader><CardContent>{error ? <div className="flex justify-between gap-4 text-sm text-risk"><span>Audit history is unavailable.</span><button type="button" className="underline" onClick={onRetry}>Retry</button></div> : items.length === 0 ? <p className="border border-dashed border-border p-6 text-sm text-muted-foreground">No Guardian execution recorded yet.</p> : <ol className="space-y-3">{items.map((item) => <li key={item.key} className="border border-border bg-background p-3 text-sm"><div className="flex flex-wrap items-center gap-3"><span className={`size-2 rounded-full ${item.tone === "danger" ? "bg-risk" : item.tone === "success" ? "bg-healthy" : "bg-primary"}`} /><span className={`font-medium ${item.tone === "danger" ? "text-risk" : item.tone === "success" ? "text-healthy" : "text-foreground"}`}>{item.label}</span><span className="text-xs text-muted-foreground">{item.meta}</span>{item.link && <a href={item.link} target="_blank" rel="noreferrer" className="ml-auto font-mono text-xs text-primary hover:underline">Transaction ↗</a>}<span className="ml-auto font-mono text-xs text-muted-foreground">{item.time}</span></div>{item.detail && <p className="mt-2 text-xs text-muted-foreground">{item.detail}</p>}{item.reason && <div className="mt-2 rounded-md border border-risk/30 bg-risk/5 px-3 py-2"><p className="text-xs font-medium leading-relaxed text-risk">{item.reason}</p>{item.raw && <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">{item.raw}</p>}</div>}</li>)}</ol>}</CardContent></Card>;
}
