import { cn } from "../lib/utils";

/**
 * The vigil line — the signature visual: a health-factor scale from the
 * liquidation floor (1.0) to a restore target, with a glowing marker at the
 * live value. One element, reused small on the landing hero and full-width on
 * the dashboard.
 */
export function VigilLine({
  hf,
  threshold,
  target,
  compact = false,
  className,
}: {
  hf: number | null;
  threshold: number;
  target: number;
  compact?: boolean;
  className?: string;
}) {
  const max = Math.max(target, 2.2);
  const pct = (v: number) => `${((v - 0.8) / (max - 0.8)) * 100}%`;
  const markerPct = hf === null ? 0 : Math.min(100, Math.max(0, ((hf - 0.8) / (max - 0.8)) * 100));

  const state = hf === null ? "none" : hf < threshold ? "risk" : hf < target ? "watch" : "healthy";
  const markerColor =
    state === "risk" ? "bg-risk" : state === "watch" ? "bg-watch" : state === "healthy" ? "bg-healthy" : "bg-primary";

  return (
    <div className={cn("select-none", className)}>
      {/* Scale bar */}
      <div className="relative h-1.5 w-full rounded-full bg-secondary">
        {/* Danger zone (0.8 → 1.0 + small buffer) */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-risk/40"
          style={{ width: pct(1.15) }}
        />
        {/* Watch zone (threshold band) */}
        <div
          className="absolute inset-y-0 rounded-full bg-watch/40"
          style={{ left: pct(1.15), width: `calc(${pct(threshold + 0.1)} - ${pct(1.15)})` }}
        />
        {/* Live marker */}
        <div
          className={cn(
            "absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-700",
            markerColor,
            state !== "none" && "vigil-glow",
          )}
          style={{ left: `${markerPct}%` }}
        />
      </div>

      {/* Labels */}
      <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="text-risk">1.0 liquidated</span>
        <span className="text-watch">act {threshold.toFixed(2)}</span>
        <span className="text-healthy">restore {target.toFixed(2)}</span>
      </div>

      {!compact && hf !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Live health factor{" "}
          <span className={cn("font-mono font-semibold", state === "risk" ? "text-risk" : state === "watch" ? "text-watch" : "text-healthy")}>
            {hf.toFixed(4)}
          </span>
        </p>
      )}
    </div>
  );
}
