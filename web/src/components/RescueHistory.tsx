import type { Rescue } from "../api.js";

/**
 * Past rescues the Guardian executed — read from Aave Pool events onchain, so each
 * row links to the real transaction on Etherscan. This is the proof the agent acts.
 */
export function RescueHistory({ rescues }: { rescues: Rescue[] }) {
  return (
    <section className="card history">
      <h2>Rescue history</h2>
      {rescues.length === 0 ? (
        <p className="muted">No rescues yet.</p>
      ) : (
        <ul className="history-list">
          {rescues.map((r) => (
            <li key={r.txHash}>
              <span className={`pill ${r.type}`}>{r.type === "repay" ? "Repaid" : "Supplied"}</span>
              <span className="history-amount">
                {fmt(r.amountHuman)} {r.asset}
              </span>
              <span className="history-block">block {r.block.toLocaleString()}</span>
              <a href={r.link} target="_blank" rel="noreferrer" className="history-link">
                {short(r.txHash)} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
