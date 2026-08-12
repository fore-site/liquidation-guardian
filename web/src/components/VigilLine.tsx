import { cn } from "../lib/utils.js";

export function VigilLine({ hf, threshold, target, compact = false, className }: { hf: number | null; threshold: number; target: number; compact?: boolean; className?: string }) {
  const max = Math.max(target, 2.2);
  const pct = (value: number) => `${((value - 0.8) / (max - 0.8)) * 100}%`;
  const markerPct = hf === null ? 0 : Math.min(100, Math.max(0, ((hf - 0.8) / (max - 0.8)) * 100));
  const state = hf === null ? "none" : hf < threshold ? "risk" : hf < target ? "watch" : "healthy";
  const markerColor = state === "risk" ? "bg-risk" : state === "watch" ? "bg-watch" : state === "healthy" ? "bg-healthy" : "bg-primary";
  return <div className={cn("select-none", className)}>
    <div className="relative h-2 w-full overflow-visible rounded-full bg-secondary">
      <div className="absolute inset-y-0 left-0 rounded-full bg-risk/70" style={{ width: pct(1.15) }} />
      <div className="absolute inset-y-0 rounded-full bg-watch/70" style={{ left: pct(1.15), width: `calc(${pct(threshold + 0.1)} - ${pct(1.15)})` }} />
      <div className="absolute inset-y-0 rounded-full bg-healthy/70" style={{ left: pct(target), width: `calc(100% - ${pct(target)})` }} />
      <div className={cn("absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background transition-[left] duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]", markerColor)} style={{ left: `${markerPct}%` }} />
    </div>
    <div className="mt-3 flex justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="text-risk">1.0 floor</span><span className="text-watch">act {threshold.toFixed(2)}</span><span className="text-healthy">restore {target.toFixed(2)}</span>
    </div>
    {!compact && hf !== null && <p className="mt-2 text-xs text-muted-foreground">Live health factor <span className={cn("font-mono font-semibold", state === "risk" ? "text-risk" : state === "watch" ? "text-watch" : "text-healthy")}>{hf.toFixed(4)}</span></p>}
  </div>;
}
