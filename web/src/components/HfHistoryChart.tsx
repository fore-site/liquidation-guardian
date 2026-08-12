import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getHfHistory, type HfPoint } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";

/**
 * Health-factor history chart — fed by the Redis-persisted HF snapshots the
 * server records on each /api/status build.
 */
export function HfHistoryChart() {
  const { data = [], isError, refetch } = useQuery({
    queryKey: ["hf-history"],
    queryFn: getHfHistory,
    refetchInterval: 15_000,
  });

  const points: Array<{ t: string; hf: number }> = data
    .filter((p): p is HfPoint & { hf: number } => p.hf !== null)
    .map((p) => ({ t: new Date(p.t).toLocaleTimeString(), hf: p.hf }));

  return (
    <Card className="bg-card">
      <CardHeader>
        <CardTitle>Health factor over time</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>History is temporarily unavailable.</span>
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => void refetch()}>Retry</button>
          </div>
        ) : points.length < 2 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Not enough data yet — the chart fills in as the dashboard polls.
          </div>
        ) : (
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="hfFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FF3B0E" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#FF3B0E" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#272727" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" stroke="#8a8a93" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis
                  stroke="#8a8a93"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  domain={[(dataMin: number) => Math.floor((dataMin - 0.1) * 100) / 100, (dataMax: number) => Math.ceil((dataMax + 0.1) * 100) / 100]}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1f1f1f",
                    border: "1px solid #272727",
                    borderRadius: 8,
                    fontSize: 12,
                    fontFamily: "Geist, ui-sans-serif, system-ui",
                  }}
                  labelStyle={{ color: "#8a8a93" }}
                />
                <Area type="monotone" dataKey="hf" stroke="#FF3B0E" strokeWidth={2} fill="url(#hfFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
