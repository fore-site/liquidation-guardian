import type { Status } from "../api.js";

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
    <section className={`hero ${state}`}>
      <div className="hero-main">
        <span className="hero-label">Health factor</span>
        <span className="hero-value">{hf === null ? "∞" : hf.toFixed(4)}</span>
        <span className="hero-status">{label}</span>
      </div>
      <div className="hero-markers">
        <Marker name="Liquidation" value="1.00" tone="risk" />
        <Marker name="Act below" value={hfThreshold.toFixed(2)} tone="watch" />
        <Marker name="Restore to" value={hfTarget.toFixed(2)} tone="healthy" />
      </div>
    </section>
  );
}

function Marker({ name, value, tone }: { name: string; value: string; tone: string }) {
  return (
    <div className={`marker ${tone}`}>
      <span className="marker-value">{value}</span>
      <span className="marker-name">{name}</span>
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
