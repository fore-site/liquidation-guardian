import type { Asset, Status } from "../api.js";

/** Collateral and debt breakdown — the two sides of the position, in USD and per-asset. */
export function PositionCard({ status }: { status: Status }) {
  const { totalCollateralUsd, totalDebtUsd, availableBorrowsUsd, liquidationThreshold } = status;

  return (
    <section className="card">
      <h2>Position</h2>

      <div className="totals">
        <Total label="Collateral" value={usd(totalCollateralUsd)} tone="healthy" />
        <Total label="Debt" value={usd(totalDebtUsd)} tone="risk" />
        <Total label="Borrowable" value={usd(availableBorrowsUsd)} tone="muted" />
      </div>

      <div className="meta-row">
        <span>Liquidation threshold</span>
        <span>{(liquidationThreshold * 100).toFixed(1)}%</span>
      </div>

      <AssetList title="Collateral" assets={status.collaterals} empty="No collateral supplied" />
      <AssetList title="Debt" assets={status.debts} empty="No outstanding debt" />
    </section>
  );
}

function AssetList({ title, assets, empty }: { title: string; assets: Asset[]; empty: string }) {
  return (
    <div className="asset-list">
      <h3>{title}</h3>
      {assets.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {assets.map((a) => (
            <li key={a.address}>
              <span className="asset-symbol">{a.symbol}</span>
              <span className="asset-amount">
                {fmt(a.tokensHuman)}
                {a.priceUsd != null && (
                  <span className="asset-usd"> · {usd(a.tokensHuman * a.priceUsd)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`total ${tone}`}>
      <span className="total-value">{value}</span>
      <span className="total-label">{label}</span>
    </div>
  );
}

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
