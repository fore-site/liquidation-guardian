import type { Asset, Status } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

/** Collateral and debt breakdown — the two sides of the position, in USD and per-asset. */
export function PositionCard({ status }: { status: Status }) {
  const { totalCollateralUsd, totalDebtUsd, availableBorrowsUsd, liquidationThreshold } = status;

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Position</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Total label="Collateral" value={usd(totalCollateralUsd)} tone="text-healthy" />
          <Total label="Debt" value={usd(totalDebtUsd)} tone="text-risk" />
          <Total label="Borrowable" value={usd(availableBorrowsUsd)} tone="text-muted-foreground" />
        </div>

        <div className="flex justify-between border-t border-border pt-3 text-sm text-muted-foreground">
          <span>Liquidation threshold</span>
          <span className="font-semibold text-foreground">{(liquidationThreshold * 100).toFixed(1)}%</span>
        </div>

        <AssetList title="Collateral" assets={status.collaterals} empty="No collateral supplied" />
        <AssetList title="Debt" assets={status.debts} empty="No outstanding debt" />
      </CardContent>
    </Card>
  );
}

function AssetList({ title, assets, empty }: { title: string; assets: Asset[]; empty: string }) {
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{title}</p>
      {assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {assets.map((a) => (
            <li key={a.address} className="flex justify-between py-1.5 text-sm">
              <span className="font-semibold">{a.symbol}</span>
              <span className="tabular-nums">
                {fmt(a.tokensHuman)}
                {a.priceUsd != null && (
                  <span className="text-muted-foreground"> · {usd(a.tokensHuman * a.priceUsd)}</span>
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
    <div className="rounded-xl bg-secondary/60 p-3">
      <span className={`block text-lg font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="block text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
