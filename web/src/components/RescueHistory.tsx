import type { Rescue } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

/**
 * Past rescues the Guardian executed — read from Aave Pool events onchain, so each
 * row links to the real transaction on Etherscan. This is the proof the agent acts.
 */
export function RescueHistory({ rescues }: { rescues: Rescue[] }) {
  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Rescue history</CardTitle>
      </CardHeader>
      <CardContent>
        {rescues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rescues yet.</p>
        ) : (
          <ul className="space-y-2">
            {rescues.map((r) => (
              <li
                key={r.txHash}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3"
              >
                <Badge variant={r.type === "repay" ? "default" : "success"}>
                  {r.type === "repay" ? "Repaid" : "Supplied"}
                </Badge>
                <span className="font-semibold tabular-nums">
                  {fmt(r.amountHuman)} {r.asset}
                </span>
                <span className="text-xs text-muted-foreground">block {r.block.toLocaleString()}</span>
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
