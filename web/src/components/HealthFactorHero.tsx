import type { Status } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent } from "./ui/card.js";
import { VigilLine } from "./VigilLine.js";

/**
 * The headline: the health factor on the vigil line, colored by how close it
 * is to liquidation.
 *   ≥ target      → healthy (green)
 *   threshold–target → watch (amber)
 *   < threshold   → at risk (red): the Guardian would act
 *   ∞ / no debt   → neutral
 */
export function HealthFactorHero({ status }: { status: Status }) {
  const { healthFactor: hf, hfThreshold, hfTarget } = status;

  const state = hfState(hf, hfThreshold, hfTarget);
  const label = {
    healthy: "Healthy",
    watch: "Watch",
    risk: "At risk — Guardian would act",
    none: "No debt",
  }[state];
  const badgeVariant =
    state === "healthy" ? "success" : state === "watch" ? "warning" : state === "risk" ? "danger" : "secondary";

  return (
    <Card className="border-0 bg-card">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Health factor</p>
            <p className="mt-1 font-mono text-6xl font-semibold leading-none tabular-nums tracking-tight">
              {hf === null ? "∞" : hf.toFixed(4)}
            </p>
            <div className="mt-3">
              <Badge variant={badgeVariant}>{label}</Badge>
            </div>
          </div>
          <div className="w-full sm:w-64">
            <VigilLine hf={hf} threshold={hfThreshold} target={hfTarget} compact />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function hfState(
  hf: number | null,
  threshold: number,
  target: number,
): "healthy" | "watch" | "risk" | "none" {
  if (hf === null) return "none";
  if (hf < threshold) return "risk";
  if (hf < target) return "watch";
  return "healthy";
}
