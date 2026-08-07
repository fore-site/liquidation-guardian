import { useMemo, useState } from "react";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

const ASSETS = ["LINK", "ETH", "USDC", "DAI"];
const CHAINS = ["Ethereum", "Arbitrum", "Base", "Polygon", "Solana", "Optimism"];

/** Approx Aave liquidation bonus + haircut on a seized position, as a fraction. */
const LIQUIDATION_PENALTY = 0.08;

export function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top nav — 1inch style */}
      <nav className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-8">
          <span className="text-lg font-bold tracking-tight">
            Liquidation<span className="text-primary">Guardian</span>
          </span>
          <div className="hidden gap-6 text-sm text-muted-foreground md:flex">
            <a href="#calculator" className="hover:text-foreground">Calculator</a>
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#trust" className="hover:text-foreground">Trust</a>
          </div>
        </div>
        <Button asChild size="lg" className="rounded-full">
          <a href="/onboard">Get started</a>
        </Button>
      </nav>

      {/* Hero — big centered headline + floating chain cards */}
      <section className="relative mx-auto max-w-5xl px-6 pt-24 pb-20 text-center">
        <h1 className="mx-auto max-w-3xl text-balance text-5xl font-bold leading-tight tracking-tight md:text-7xl">
          Never get <span className="text-primary">liquidated</span> while you sleep
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
          Workflow watches. <span className="font-semibold text-foreground">LLM decides.</span>{" "}
          KeeperHub executes. An AI agent keeps your Aave position safe — choosing the cheapest
          fix, then executing it onchain.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Button asChild size="lg" className="rounded-full">
            <a href="/onboard">Get started</a>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-full">
            <a href="#calculator">See the math</a>
          </Button>
        </div>

        {/* Floating cards (1inch-style scattered) */}
        <div className="mt-20 grid grid-cols-3 gap-4 md:grid-cols-6">
          {CHAINS.map((c, i) => (
            <Card
              key={c}
              className={`bg-card/80 p-4 text-center ${i % 2 ? "translate-y-4" : ""} ${
                i === 2 || i === 3 ? "text-primary" : ""
              }`}
            >
              <div className="text-xl font-bold">{c.slice(0, 2)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{c}</div>
            </Card>
          ))}
        </div>
      </section>

      <RoiCalculator />

      {/* Three pillars */}
      <section id="how" className="mx-auto max-w-5xl px-6 py-16">
        <div className="grid gap-4 md:grid-cols-3">
          <PillarCard
            title="Dynamic Risk Awareness"
            body="Rigid bots act on rules. The Guardian reads the whole picture — health factor, balances, allowance, and the cost of each fix — and chooses the cheapest executable lever, with reasoning you can audit."
          />
          <PillarCard
            title="One-Click Strategy Blueprints"
            body="No DeFi PhD required. Pick a defense profile in plain English — the Conservative acts early for safety; the Capital Efficient rides the edge for yield."
          />
          <PillarCard
            id="trust"
            title="Non-Custodial Trust"
            body="The agent holds no keys. It only carries limited execution permission — repay debt or add collateral on your position, never withdraw. Your key stays server-side, encrypted."
          />
        </div>
      </section>
    </div>
  );
}

function PillarCard({ title, body, id }: { title: string; body: string; id?: string }) {
  return (
    <Card id={id} className="bg-card">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}

function RoiCalculator() {
  const [asset, setAsset] = useState("LINK");
  const [borrowUsd, setBorrowUsd] = useState(10000);
  const [hf, setHf] = useState(1.2);

  const result = useMemo(() => {
    const penalty = borrowUsd * LIQUIDATION_PENALTY;
    const rescueCost = borrowUsd * 0.03;
    const gas = 0;
    const avoided = Math.max(0, penalty - (rescueCost + gas));
    const risk = hf <= 1.0 ? "Liquidating" : hf <= 1.1 ? "High" : hf <= 1.3 ? "Elevated" : "Moderate";
    const liquidating = hf <= 1.0;
    return { penalty, rescueCost, gas, avoided, risk, liquidating };
  }, [borrowUsd, hf]);

  return (
    <section id="calculator" className="mx-auto max-w-4xl px-6 py-10">
      <Card className="bg-card">
        <CardHeader>
          <CardTitle className="text-xl">What does liquidation cost you?</CardTitle>
          <CardDescription>
            See the penalty you're exposed to — and what the Guardian's fix costs in comparison.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Asset</Label>
              <select
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {ASSETS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Borrow amount ($)</Label>
              <Input
                type="number"
                min={100}
                step={500}
                value={borrowUsd}
                onChange={(e) => setBorrowUsd(Math.max(0, Number(e.target.value)))}
              />
            </div>
            <div className="space-y-2">
              <Label>Current health factor</Label>
              <Input
                type="number"
                min={0.5}
                max={2}
                step={0.05}
                value={hf}
                onChange={(e) => setHf(Math.min(2, Math.max(0.5, Number(e.target.value))))}
              />
            </div>
          </div>

          <div className="mt-6 space-y-3 rounded-xl bg-secondary/60 p-5">
            <div className="text-sm">
              Risk level:{" "}
              <span
                className={`font-semibold ${
                  result.risk === "Liquidating" || result.risk === "High"
                    ? "text-risk"
                    : result.risk === "Elevated"
                      ? "text-watch"
                      : "text-healthy"
                }`}
              >
                {result.risk}
              </span>
            </div>
            {result.liquidating ? (
              <p className="text-sm text-muted-foreground">
                At or below HF <strong className="text-foreground">1.0</strong> you're being
                liquidated: liquidators can seize <strong>up to 50%</strong> of debt (HF ≥ 0.95) or{" "}
                <strong>up to 100%</strong> (HF &lt; 0.95), taking collateral at a{" "}
                <strong>~8% bonus</strong> per seizure. The Guardian races to rescue you.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                If liquidated today, you face ~<strong className="text-foreground">${result.penalty.toFixed(0)}</strong>{" "}
                in liquidation penalty.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              The Guardian's fix costs ~<strong className="text-foreground">${result.rescueCost.toFixed(0)}</strong>{" "}
              in tokens + <strong className="text-foreground">${result.gas}</strong> gas (sponsored on this demo chain).
            </p>
            <p className="text-base font-semibold text-primary">
              You avoid ~${result.avoided.toFixed(0)} by acting before liquidation.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
