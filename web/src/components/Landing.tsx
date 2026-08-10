import { useMemo, useState } from "react";
import { Button } from "./ui/button.js";
import { Reveal, TaglineReveal } from "../lib/motion.js";
import { VigilLine } from "./VigilLine.js";

const ASSETS = ["LINK", "ETH", "USDC", "DAI"];
const LIQUIDATION_PENALTY = 0.08;

const BENEFITS = [
  {
    title: "Acts before the auction",
    body: "Aave seizes collateral at a discount the moment your health factor crosses 1.0. The Guardian moves first, restoring the position while the penalty is still avoidable.",
  },
  {
    title: "Picks the cheapest fix, with reasoning",
    body: "Repay debt or add collateral? The LLM weighs both levers plus the gas, and shows you the reasoning behind the choice. Amounts are computed in code, never guessed.",
  },
  {
    title: "Watches the chain, not the clock",
    body: "An event watcher reacts to the pool events that move your position within a block or two, instead of waiting for the next scheduled check.",
  },
  {
    title: "Never holds your keys",
    body: "The agent carries limited execution permission only. It can repay or supply on your position, never withdraw. Your KeeperHub key stays server-side, encrypted.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Connect your position",
    body: "Paste your KeeperHub key and wallet once. The key is encrypted at rest and never reaches the browser again.",
  },
  {
    n: "02",
    title: "Set your defense profile",
    body: "Act early for safety, or ride closer to the edge. Two plain-English presets over the threshold and target engine.",
  },
  {
    n: "03",
    title: "Sleep, and get alerted",
    body: "The watcher tracks every move. When the health factor drops, you get a one-tap rescue in Telegram, or the Guardian acts autonomously.",
  },
];

const FAQS = [
  {
    q: "What exactly is a health factor?",
    a: "Aave's measure of how much room your position has before liquidation. Above 1.0 you are safe; at 1.0 liquidators can seize your collateral. The Guardian acts with a margin above that line.",
  },
  {
    q: "Does the agent ever control my funds?",
    a: "No. It carries limited execution permission scoped to repaying debt or adding collateral on your position. It cannot withdraw to any external wallet.",
  },
  {
    q: "Where does my KeeperHub key live?",
    a: "Server-side, encrypted with AES-256-GCM. The browser and Telegram only ever see public data: health factors, amounts, and transaction links.",
  },
  {
    q: "What happens if the LLM is slow or down?",
    a: "The decision falls back to deterministic sizing. The position is still protected; the model is only ever the judgment layer, never the safety net.",
  },
  {
    q: "Is every rescue executed onchain?",
    a: "Yes. Every write goes through KeeperHub with a simulate-first preflight, and each transaction is linkable on the explorer.",
  },
  {
    q: "Which networks are supported?",
    a: "Sepolia is the live demo chain. The same code path works on any chain where Aave v3 is deployed through KeeperHub.",
  },
];

export function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      {/* Noise overlay - fixed, pointer-events-none */}
      <div className="noise-overlay" aria-hidden="true" />
      <IslandNav />
      <Hero />
      <Benefits />
      <HowItWorks />
      <Tagline />
      <RoiCalculator />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ── Floating glass island nav (B7) ───────────────────────────────────────── */
function IslandNav() {
  const [open, setOpen] = useState(false);
  return (
    <div className="sticky top-0 z-40 px-4 pt-6">
      <nav className="glass mx-auto flex w-max max-w-full items-center gap-8 rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
        <a href="/" className="px-2 text-sm font-semibold tracking-tight">
          Liquidation<span className="text-accent">Guardian</span>
        </a>
        <div className="hidden items-center gap-1 md:flex">
          <NavLink href="#how">How it works</NavLink>
          <NavLink href="#calculator">Calculator</NavLink>
          <NavLink href="#faq">FAQ</NavLink>
        </div>
        <div className="hidden md:block">
          <Button asChild size="sm" className="rounded-full magneticIcon">
            <a href="/onboard">Get started</a>
            {/* Magnetic trailing icon */}
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 5l-5 5h3v7h4v-7h3z" />
            </svg>
          </Button>
        </div>
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="relative flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-secondary md:hidden"
        >
          <span
            className={`absolute h-[1px] w-4 bg-foreground transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
              open ? "rotate-45" : "-translate-y-[3px]"
            }`}
          />
          <span
            className={`absolute h-[1px] w-4 bg-foreground transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
              open ? "-rotate-45" : "translate-y-[3px]"
            }`}
          />
        </button>
      </nav>

      {/* Mobile glass overlay menu with staggered reveal */}
      {open && (
        <div className="glass-heavy fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 md:hidden">
          {[
            "How it works",
            "Calculator",
            "FAQ",
          ].map((label, i) => (
            <a
              key={label}
              href={`#${label === "How it works" ? "how" : label === "Calculator" ? "calculator" : "faq"}`}
              onClick={() => setOpen(false)}
              className={`fluid text-2xl font-semibold ${
                open ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
              }`}
              style={{ transitionDelay: `${100 + i * 60}ms` }}
            >
              {label}
            </a>
          ))}
          <Button
            asChild
            size="lg"
            className={`fluid mt-4 rounded-full ${
              open ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
            }`}
            style={{ transitionDelay: "340ms" }}
          >
            <a href="/onboard" onClick={() => setOpen(false)}>
              Get started
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="fluid-fast rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground">
      {children}
    </a>
  );
}

/* ── Hero ─────────────────────────────────────────────────────────────────── */
function Hero() {
  return (
    <section className="relative mx-auto max-w-[1440px] px-6 pb-24 pt-14 text-center sm:pt-20">
      <Reveal delay={40} className="stagger-1">
        <p className="mx-auto inline-flex items-center gap-2 rounded-[2rem] p-1.5 bg-black/10 border border-white/5 px-3 py-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-healthy" />
          Event watcher · LLM decides · KeeperHub executes
        </p>
      </Reveal>

      <Reveal delay={120} className="stagger-2">
        <h1 className="hero-gradient mx-auto mt-6 max-w-[680px] text-balance text-[4.5rem] font-semibold leading-[1.05] tracking-tight sm:text-[5.5rem]">
          Never get liquidated while you sleep
        </h1>
      </Reveal>

      <Reveal delay={200} className="stagger-3">
        <p className="mx-auto mt-6 max-w-[680px] text-lg text-muted-foreground">
          Liquidation Guardian watches your Aave position, picks the cheapest fix before the auction starts, and executes it onchain through KeeperHub. Simulated first, never blind.
        </p>
      </Reveal>

      <Reveal delay={280} className="stagger-4">
        <div className="mt-10 flex flex-wrap items-center justify-center gap-6">
          <Button asChild size="lg" className="rounded-full magneticIcon">
            <a href="/onboard">Get started</a>
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 5l-5 5h3v7h4v-7h3z" />
            </svg>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-full">
            <a href="#calculator">See the math</a>
          </Button>
        </div>
      </Reveal>

      {/* The vigil line — the product's own visual, live on the landing page. */}
      <Reveal delay={360} className="stagger-5">
        <div className="mx-auto mt-16 max-w-2xl rounded-[2rem] p-1.5 bg-black/10 border border-white/5 p-6 text-left">
          <p className="mb-4 text-xs uppercase tracking-widest text-muted-foreground">
            A position in danger, one rescue away
          </p>
          <VigilLine hf={1.09} threshold={1.15} target={1.5} />
        </div>
      </Reveal>
    </section>
  );
}

/* ── Benefits ─────────────────────────────────────────────────────────────── */
function Benefits() {
  return (
    <section id="how" className="mx-auto max-w-[1440px] scroll-mt-28 px-6 py-16">
      <Reveal delay={40} className="stagger-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Why it works</p>
        <h2 className="mt-3 max-w-[680px] text-3xl font-semibold tracking-tight sm:text-4xl">
          A guardian that reasons, not a bot that beeps
        </h2>
      </Reveal>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {BENEFITS.map((b, i) => (
          <Reveal key={b.title} delay={i * 60 + 40} as="li" className={`stagger-${i + 2}`}>
            <div className="rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
              <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border p-6 h-full">
                <h3 className="text-lg font-semibold">{b.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{b.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ── How it works ─────────────────────────────────────────────────────────── */
function HowItWorks() {
  return (
    <section className="mx-auto max-w-[1440px] px-6 py-16">
      <Reveal delay={40} className="stagger-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Setup</p>
        <h2 className="mt-3 max-w-[680px] text-3xl font-semibold tracking-tight sm:text-4xl">
          Three steps to a guarded position
        </h2>
      </Reveal>
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 80 + 40} as="li" className={`stagger-${i + 2}`}>
            <div className="rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
              <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border p-6 h-full">
                <span className="font-mono text-sm text-accent">{s.n}</span>
                <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ── Tagline reveal (B11) ─────────────────────────────────────────────────── */
function Tagline() {
  return (
    <section className="mx-auto max-w-[1440px] px-6 py-24">
      <TaglineReveal
        text="A liquidation happens in seconds. The Guardian never sleeps, so you can."
        className="mx-auto max-w-[680px] text-center text-4xl font-semibold leading-tight tracking-tight sm:text-5xl stagger-1"
      />
    </section>
  );
}

/* ── ROI calculator ───────────────────────────────────────────────────────── */
function RoiCalculator() {
  const [asset, setAsset] = useState("LINK");
  const [borrowUsd, setBorrowUsd] = useState(10000);
  const [hf, setHf] = useState(1.2);

  const result = useMemo(() => {
    const penalty = borrowUsd * LIQUIDATION_PENALTY;
    const rescueCost = borrowUsd * 0.03;
    const avoided = Math.max(0, penalty - rescueCost);
    const risk = hf <= 1.0 ? "Liquidating" : hf <= 1.1 ? "High" : hf <= 1.3 ? "Elevated" : "Moderate";
    return { penalty, rescueCost, avoided, risk };
  }, [borrowUsd, hf]);

  return (
    <section id="calculator" className="mx-auto max-w-[1440px] scroll-mt-28 px-6 py-16">
      <Reveal delay={40} className="stagger-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">The math</p>
        <h2 className="mt-3 max-w-[680px] text-3xl font-semibold tracking-tight sm:text-4xl">
          What does liquidation cost you?
        </h2>
        <p className="mt-3 max-w-[680px] text-muted-foreground">
          See the penalty you are exposed to, and what the Guardian's fix costs in comparison.
        </p>
      </Reveal>

      <Reveal delay={100} className="stagger-2">
        <div className="mt-8 rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
          <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border p-6">
            <div className="grid gap-6 md:grid-cols-3">
              <Field label="Asset">
                <select
                  value={asset}
                  onChange={(e) => setAsset(e.target.value)}
                  className="h-11 w-full rounded-full border border-input bg-background px-4 py-2.5 font-mono text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 hover:border-primary/30"
                >
                  {ASSETS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Borrow amount ($)">
                <input
                  type="number"
                  min={100}
                  step={500}
                  value={borrowUsd}
                  onChange={(e) => setBorrowUsd(Math.max(0, Number(e.target.value)))}
                  className="h-11 w-full rounded-full border border-input bg-background px-4 py-2.5 font-mono text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 hover:border-primary/30"
                />
              </Field>
              <Field label="Current health factor">
                <input
                  type="number"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={hf}
                  onChange={(e) => setHf(Math.min(2, Math.max(0.5, Number(e.target.value))))}
                  className="h-11 w-full rounded-full border border-input bg-background px-4 py-2.5 font-mono text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 hover:border-primary/30"
                />
              </Field>
            </div>

            <div className="mt-6 space-y-4 rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
              <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border p-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Risk level</span>
                    <span className={`font-semibold ${result.risk === "Liquidating" || result.risk === "High" ? "text-risk" : result.risk === "Elevated" ? "text-watch" : "text-healthy"}`}>
                      {result.risk}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Penalty if liquidated</span>
                    <span className="font-mono font-semibold text-foreground">${result.penalty.toFixed(0)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Guardian's fix</span>
                    <span className="font-mono font-semibold text-foreground">${result.rescueCost.toFixed(0)}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <span className="text-sm font-semibold">You avoid</span>
                    <span className="font-mono text-lg font-semibold text-primary">${result.avoided.toFixed(0)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/* ── FAQ ──────────────────────────────────────────────────────────────────── */
function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="mx-auto max-w-[1440px] scroll-mt-28 px-6 py-16">
      <Reveal delay={40} className="stagger-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">FAQ</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Questions, answered</h2>
      </Reveal>
      <div className="mt-8 divide-y divide-border rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
        <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border">
          {FAQS.map((f, i) => (
            <div key={f.q}>
              <button
                type="button"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between gap-6 px-6 py-4 text-left text-sm font-medium transition-colors hover:bg-secondary/30"
              >
                {f.q}
                <span
                  className={`shrink-0 font-mono text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
                    open === i ? "rotate-45" : ""
                  }`}
                >
                  +
                </span>
              </button>
              {open === i && (
                <p className="px-6 pb-4 text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Final CTA + footer ───────────────────────────────────────────────────── */
function FinalCta() {
  return (
    <section className="mx-auto max-w-[1440px] px-6 py-24 text-center">
      <Reveal delay={40} className="stagger-1">
        <h2 className="mx-auto max-w-[680px] text-4xl font-semibold tracking-tight sm:text-5xl">
          The auction starts at 1.0. Start before it does.
        </h2>
        <p className="mx-auto mt-4 max-w-[680px] text-muted-foreground">
          Connect your position in under a minute. No wallet signing, no keys in your browser.
        </p>
        <div className="mt-8">
          <Button asChild size="lg" className="rounded-full magneticIcon">
            <a href="/onboard">Get started</a>
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 5l-5 5h3v7h4v-7h3z" />
            </svg>
          </Button>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-[1440px] flex flex-col items-center justify-between gap-6 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
        <span>
          Liquidation<span className="text-accent">Guardian</span>
        </span>
        <div className="flex gap-6">
          <a href="/privacy" className="hover:text-foreground">Privacy</a>
          <a href="/terms" className="hover:text-foreground">Terms</a>
          <a href="https://keeperhub.com" target="_blank" rel="noreferrer" className="hover:text-foreground">
            KeeperHub
          </a>
        </div>
      </div>
    </footer>
  );
}