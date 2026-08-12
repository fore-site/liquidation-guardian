import type { Status } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent } from "./ui/card.js";
import { VigilLine } from "./VigilLine.js";

export function HealthFactorHero({ status }: { status: Status }) {
  const { healthFactor: hf, hfThreshold, hfTarget } = status;
  const state = hfState(hf, hfThreshold, hfTarget);
  const label = { healthy: "Healthy", watch: "Watch", risk: "At risk", none: "No debt" }[state];
  const badgeVariant = state === "healthy" ? "success" : state === "watch" ? "warning" : state === "risk" ? "danger" : "secondary";
  return <Card className="border-primary/40"><CardContent className="p-6 sm:p-8"><div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between"><div><p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Health factor</p><div className="mt-3 flex flex-wrap items-end gap-4"><p className="font-mono text-7xl font-light leading-none tracking-[-0.08em] tabular-nums">{hf === null ? "∞" : hf.toFixed(4)}</p><Badge variant={badgeVariant}>{label}</Badge></div><p className="mt-4 max-w-md text-sm text-muted-foreground">{state === "risk" ? "The Guardian would act below your configured line." : state === "watch" ? "The position is below its restore target." : state === "none" ? "No borrowed assets are currently recorded." : "The position is above its restore target."}</p></div><div className="w-full max-w-xl lg:pt-5"><VigilLine hf={hf} threshold={hfThreshold} target={hfTarget} /></div></div></CardContent></Card>;
}
function hfState(hf: number | null, threshold: number, target: number): "healthy" | "watch" | "risk" | "none" { if (hf === null) return "none"; if (hf < threshold) return "risk"; if (hf < target) return "watch"; return "healthy"; }
