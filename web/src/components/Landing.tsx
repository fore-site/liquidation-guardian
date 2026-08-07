import { useMemo, useState } from "react";

/**
 * Marketing landing: hero + three pillars + an avoided-loss ROI calculator.
 * Rendered when no session is connected; the Onboarding form lives below the
 * fold ("Get started"). Pure frontend — the calculator is honest illustration
 * math, not a live position read.
 */

const ASSETS = ["LINK", "ETH", "USDC", "DAI"];

/** Approx Aave liquidation bonus + haircut on a seized position, as a fraction. */
const LIQUIDATION_PENALTY = 0.08;

export function Landing() {
  return (
    <div className="landing">
      <header className="landing-hero">
        <h1>Liquidation Guardian</h1>
        <p className="tagline">
          Workflow watches. <strong>LLM decides.</strong> KeeperHub executes.
        </p>
        <p className="sub">
          An AI agent that keeps your Aave borrow position safe from liquidation —
          deciding the cheapest fix, then executing it onchain through KeeperHub.
        </p>
        <a className="primary landing-cta" href="/start">
          Get started
        </a>
      </header>

      <RoiCalculator />

      <section className="pillars">
        <div className="pillar">
          <h2>Dynamic Risk Awareness</h2>
          <p>
            Rigid bots act on rules ("repay at 1.1"). The Guardian reads the whole
            picture — health factor, balances, allowance, and the <em>cost of each
            fix</em> — and chooses the cheapest executable lever, with reasoning
            you can audit.
          </p>
        </div>
        <div className="pillar">
          <h2>One-Click Strategy Blueprints</h2>
          <p>
            No DeFi PhD required. Pick a defense profile in plain English — the
            Conservative acts early for safety; the Capital Efficient rides the
            edge for yield — and the Guardian maps it to real thresholds.
          </p>
        </div>
        <div className="pillar">
          <h2>Non-Custodial Trust</h2>
          <p>
            The agent holds no keys. It only carries limited execution permission —
            to repay debt or add collateral on your position, never to withdraw to
            an external wallet. Your key stays server-side, encrypted.
          </p>
        </div>
      </section>
    </div>
  );
}

function RoiCalculator() {
  const [asset, setAsset] = useState("LINK");
  const [borrowUsd, setBorrowUsd] = useState(10000);
  const [hf, setHf] = useState(1.2);

  const result = useMemo(() => {
    // Honest illustration of Aave v3 mechanics:
    // - Above 1.0: you're eligible for rescue; liquidation is a future risk.
    // - At/below 1.0: liquidators can seize — up to 50% of debt at HF ≥ 0.95
    //   (both sides ≥ $2k), up to 100% at HF < 0.95 or small positions. Each
    //   seizure takes collateral worth the repaid debt PLUS the liquidation
    //   bonus (~5-10%) — so below 1.0 the position is being eaten in chunks.
    // The Guardian's rescue costs tokens spent to restore HF (illustrated as a
    // fraction of debt) + gas (sponsored on the demo chain, so $0).
    const penalty = borrowUsd * LIQUIDATION_PENALTY;
    const rescueCost = borrowUsd * 0.03; // illustrative: tokens spent to restore HF
    const gas = 0; // sponsored on the demo chain (Sepolia)
    const avoided = Math.max(0, penalty - (rescueCost + gas));
    const risk = hf <= 1.0 ? "Liquidating" : hf <= 1.1 ? "High" : hf <= 1.3 ? "Elevated" : "Moderate";
    const liquidating = hf <= 1.0;
    return { penalty, rescueCost, gas, avoided, risk, liquidating };
  }, [borrowUsd, hf]);

  return (
    <section className="calc card">
      <h2>What does liquidation cost you?</h2>
      <p className="muted">
        See the penalty you're exposed to — and what the Guardian's fix costs in
        comparison.
      </p>

      <div className="calc-grid">
        <label>
          <span>Asset</span>
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Borrow amount ($)</span>
          <input
            type="number"
            min={100}
            step={500}
            value={borrowUsd}
            onChange={(e) => setBorrowUsd(Math.max(0, Number(e.target.value)))}
          />
        </label>

        <label>
          <span>Current health factor</span>
          <input
            type="number"
            min={0.5}
            max={2}
            step={0.05}
            value={hf}
            onChange={(e) => setHf(Math.min(2, Math.max(0.5, Number(e.target.value))))}
          />
        </label>
      </div>

      <div className="calc-result">
        <div className={`calc-risk risk-${result.risk.toLowerCase()}`}>
          Risk level: <strong>{result.risk}</strong>
        </div>

        {result.liquidating ? (
          <div className="calc-line">
            At or below HF <strong>1.0</strong> you're being liquidated: liquidators can seize{" "}
            <strong>up to 50%</strong> of your debt (HF ≥ 0.95) or{" "}
            <strong>up to 100%</strong> (HF &lt; 0.95 or small position), taking your
            collateral at a <strong>~8% liquidation bonus</strong> per seizure — until you
            act or the position is drained. The Guardian is still racing to rescue; every
            seizure costs you the bonus.
          </div>
        ) : (
          <div className="calc-line">
            If liquidated today, you face ~<strong>${result.penalty.toFixed(0)}</strong>{" "}
            in liquidation penalty (bonus + haircut).
          </div>
        )}

        <div className="calc-line">
          The Guardian's fix costs ~<strong>${result.rescueCost.toFixed(0)}</strong>{" "}
          in tokens + <strong>${result.gas}</strong> gas (sponsored on this demo chain).
        </div>
        <div className="calc-saved">
          You avoid ~<strong>${result.avoided.toFixed(0)}</strong> by acting before
          liquidation.
        </div>
      </div>
    </section>
  );
}
