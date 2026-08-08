import type { Rescue } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

/**
 * Past rescues the Guardian executed — read from Aave Pool events onchain, so each
 * row links to the real transaction on Etherscan. This is the proof the agent acts.
 */
export function RescueHistory({ rescues, error = false, onRetry }: { rescues: Rescue[]; error?: boolean; onRetry?: () => void }) {
  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Rescue history</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>Rescue history is temporarily unavailable.</span>
            <button type="button" className="font-medium text-primary hover:underline" onClick={onRetry}>Retry</button>
          </div>
        ) : rescues.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No rescues yet. When the Guardian acts, the transactions land here.
          </div>
        ) : (
          <ul className="space-y-2">
            {rescues.map((r) => (
              <li
                key={r.txHash}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 p-3"
              >
                <Badge variant={r.type === "repay" ? "default" : "success"}>
                  {r.type === "repay" ? "Repaid" : "Supplied"}
                </Badge>
                <span className="font-semibold tabular-nums">
                  <span className="font-mono">{fmt(r.amountHuman)}</span> {r.asset}
                </span>
                <span className="font-mono text-xs text-muted-foreground">block {r.block.toLocaleString()}</span>
                <a
                  href={r.link}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto font-mono text-xs text-primary hover:underline"
                >
                  {short(r.txHash)} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
