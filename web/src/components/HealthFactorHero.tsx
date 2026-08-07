import type { Status } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent } from "./ui/card.js";

/**
 * The headline: the health factor, colored by how close it is to liquidation.
 *   ≥ target      → healthy (green)
 *   threshold–target → watch (amber): above the action line but below the restore target
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

  return (
    <Card className="mb-4 border-0 bg-gradient-to-b from-card to-background">
      <CardContent className="flex flex-wrap items-center justify-between gap-6 p-6">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Health factor</p>
          <p className="mt-1 text-6xl font-bold tabular-nums leading-none">
            {hf === null ? "∞" : hf.toFixed(4)}
          </p>
          <div className="mt-3">
            <Badge
              variant={
                state === "healthy" ? "success" : state === "watch" ? "warning" : state === "risk" ? "danger" : "secondary"
              }
            >
              {label}
            </Badge>
          </div>
        </div>
        <div className="flex gap-8">
          <Marker name="Liquidation" value="1.00" tone="danger" />
          <Marker name="Act below" value={hfThreshold.toFixed(2)} tone="warning" />
          <Marker name="Restore to" value={hfTarget.toFixed(2)} tone="success" />
        </div>
      </CardContent>
    </Card>
  );
}

function Marker({ name, value, tone }: { name: string; value: string; tone: "success" | "warning" | "danger" }) {
  const color =
    tone === "danger" ? "text-risk" : tone === "warning" ? "text-watch" : "text-healthy";
  return (
    <div className="text-center">
      <span className={`block text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">{name}</span>
    </div>
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
