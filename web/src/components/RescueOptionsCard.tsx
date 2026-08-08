import type { Candidate, Status } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

/**
 * The sized rescue levers the Guardian would choose between. Each candidate is a
 * concrete action (repay X of asset, or supply Y of asset) computed server-side.
 * We flag levers that only partially reach the target or aren't currently available.
 */
export function RescueOptionsCard({ status }: { status: Status }) {
  const { candidates } = status;

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Rescue options</CardTitle>
      </CardHeader>
      <CardContent>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status.healthFactor === null
              ? "No debt — nothing to rescue."
              : "Position is above the restore target. No action needed."}
          </p>
        ) : (
          <ul className="space-y-2">
            {candidates.map((c, i) => (
              <Option key={`${c.action}-${c.asset}-${i}`} c={c} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Option({ c }: { c: Candidate }) {
  const verb = c.action === "repay" ? "Repay" : "Supply";
  const state = !c.available ? "unavailable" : c.reachesTarget ? "full" : "partial";
  const badgeVariant = !c.available
    ? "outline"
    : c.reachesTarget
      ? "success"
      : "warning";
  const badge = { full: "Reaches target", partial: "Partial", unavailable: "Unavailable" }[state];

  return (
    <li
      className={`rounded-lg border border-border bg-secondary/40 p-3 ${
        !c.available ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {verb} <span className="font-mono tabular-nums">{fmt(c.amountHuman)}</span> {c.asset}
        </span>
        <Badge variant={badgeVariant as "success" | "warning" | "outline"}>{badge}</Badge>
      </div>
      {c.note && <p className="mt-1 text-xs text-muted-foreground">{c.note}</p>}
    </li>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
