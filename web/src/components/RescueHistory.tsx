import { useEffect, useMemo, useRef, useState } from "react";
import type { Rescue } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

const PAGE_SIZE = 30;

/**
 * Past rescues the Guardian executed — read from Aave Pool events onchain, so each
 * row links to the real transaction on Etherscan. Long histories open in a modal
 * with infinite scrolling instead of stretching the page.
 */
export function RescueHistory({ rescues, error = false, onRetry }: { rescues: Rescue[]; error?: boolean; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Rescue history</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>Rescue history is temporarily unavailable.</span>
            <button type="button" className="font-medium text-primary hover:underline" onClick={onRetry}>Retry</button>
          </div>
        ) : rescues.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No rescues yet. When the Guardian acts, the transactions land here.
          </div>
        ) : (
          <>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {rescues.slice(0, 8).map((r) => (
                <RescueRow key={r.txHash} r={r} />
              ))}
            </div>
            {rescues.length > 8 && (
              <div className="mt-3">
                <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
                  View all {rescues.length} rescues
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
      {open && <HistoryModal rescues={rescues} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function RescueRow({ r }: { r: Rescue }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 p-3">
      <Badge variant={r.type === "repay" ? "default" : "success"}>
        {r.type === "repay" ? "Repaid" : "Supplied"}
      </Badge>
      <span className="font-semibold tabular-nums">
        <span className="font-mono">{fmt(r.amountHuman)}</span> {r.asset}
      </span>
      <span className="font-mono text-xs text-muted-foreground">block {r.block.toLocaleString()}</span>
      <a
        href={r.link}
        target="_blank"
        rel="noreferrer"
        className="ml-auto font-mono text-xs text-primary hover:underline"
      >
        {short(r.txHash)} ↗
      </a>
    </li>
  );
}

/** Modal with infinite scroll: renders PAGE_SIZE rows, loads more when the sentinel is visible. */
function HistoryModal({ rescues, onClose }: { rescues: Rescue[]; onClose: () => void }) {
  const [count, setCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => rescues.slice(0, count), [rescues, count]);
  const hasMore = count < rescues.length;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setCount((c) => Math.min(c + PAGE_SIZE, rescues.length));
        }
      },
      { root: listRef.current, rootMargin: "120px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, rescues.length]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rescue history"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">Rescue history</h2>
            <p className="text-xs text-muted-foreground">
              {rescues.length} rescues, newest first
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {visible.map((r) => (
            <RescueRow key={r.txHash} r={r} />
          ))}
          <div ref={sentinelRef} className="h-2" />
          {hasMore && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Scrolling loads more…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
