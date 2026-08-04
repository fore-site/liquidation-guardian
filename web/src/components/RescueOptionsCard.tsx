import type { Candidate, Status } from "../api.js";

/**
 * The sized rescue levers the Guardian would choose between. Each candidate is a
 * concrete action (repay X of asset, or supply Y of asset) computed server-side.
 * We flag levers that only partially reach the target or aren't currently available.
 */
export function RescueOptionsCard({ status }: { status: Status }) {
  const { candidates } = status;

  return (
    <section className="card">
      <h2>Rescue options</h2>
      {candidates.length === 0 ? (
        <p className="muted">
          {status.healthFactor === null
            ? "No debt — nothing to rescue."
            : "Position is above the restore target. No action needed."}
        </p>
      ) : (
        <ul className="options">
          {candidates.map((c, i) => (
            <Option key={`${c.action}-${c.asset}-${i}`} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Option({ c }: { c: Candidate }) {
  const verb = c.action === "repay" ? "Repay" : "Supply";
  const state = !c.available ? "unavailable" : c.reachesTarget ? "full" : "partial";
  const badge = { full: "Reaches target", partial: "Partial", unavailable: "Unavailable" }[state];

  return (
    <li className={`option ${state}`}>
      <div className="option-head">
        <span className="option-action">
          {verb} {fmt(c.amountHuman)} {c.asset}
        </span>
        <span className={`badge ${state}`}>{badge}</span>
      </div>
      {c.note && <p className="option-note">{c.note}</p>}
    </li>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
