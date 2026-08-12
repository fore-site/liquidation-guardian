import { useMemo, useState } from "react";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Reveal, TaglineReveal } from "../lib/motion.js";
import { VigilLine } from "./VigilLine.js";
import { BrandMark } from "./BrandMark.js";
import { SiteFooter } from "./PageShell.js";

const BENEFITS = [
  ["01", "Acts before the auction", "The watcher reacts to position moving events instead of waiting for a fixed clock."],
  ["02", "Sizes the smallest fix", "Repay debt or add collateral. The decision layer compares both paths, then code sizes the action."],
  ["03", "Keeps withdrawal authority out", "The execution boundary is limited to protection actions. It cannot withdraw your collateral."],
  ["04", "Falls back cleanly", "If the model is slow or unavailable, deterministic sizing still protects the position."],
];

const FAQS = [
  ["What is a health factor?", "Aave uses it to show how much room a borrow position has before liquidation. Above 1.0 is safer. Near 1.0 means less room for a market move."],
  ["Does the Guardian hold my funds?", "No. It can only use the delegated execution path for repayment or added collateral. It cannot withdraw to another wallet."],
  ["Where does my KeeperHub key go?", "The key is sent once to the server over HTTPS and encrypted at rest. It is not returned to the browser after connection."],
  ["What happens when the model is unavailable?", "The system uses deterministic rescue sizing. The model helps choose between valid paths, but it is not the safety net."],
  ["Can I pause monitoring?", "Yes. The dashboard has a pause control. Pausing stops watcher actions without deleting your stored position."],
  ["Which network is live?", "The current product flow uses Sepolia with Aave v3 through KeeperHub."],
];

export function Landing() {
  return <div className="min-h-screen bg-background text-foreground">
    <LandingNav />
    <main>
      <Hero />
      <Mechanism />
      <Benefits />
      <HowItWorks />
      <Tagline />
      <RoiCalculator />
      <Security />
      <Faq />
      <FinalCta />
    </main>
    <SiteFooter />
  </div>;
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  return <header className="sticky top-0 z-[99] border-b border-border bg-background/95 backdrop-blur-sm">
    <div className="container-frame flex min-h-16 items-center justify-between gap-6">
      <a href="/" aria-label="Liquidation Guardian home"><BrandMark /></a>
      <nav className="hidden items-center gap-6 text-sm text-muted-foreground lg:flex" aria-label="Primary">
        <a href="#how" className="transition-colors duration-300 hover:text-foreground">How it works</a>
        <a href="#calculator" className="transition-colors duration-300 hover:text-foreground">The math</a>
        <a href="#faq" className="transition-colors duration-300 hover:text-foreground">FAQ</a>
      </nav>
      <div className="hidden items-center gap-3 lg:flex">
        <a href="/dashboard" className="text-sm text-muted-foreground transition-colors duration-300 hover:text-foreground">Dashboard</a>
        <Button asChild size="sm"><a href="/onboard">Protect a position</a></Button>
      </div>
      <button type="button" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex size-9 items-center justify-center rounded-full border border-border lg:hidden">
        <span className="font-mono text-xs">{open ? "×" : "☰"}</span>
      </button>
    </div>
    {open && <div className="border-t border-border bg-background px-4 py-6 lg:hidden">
      <nav className="container-frame flex flex-col gap-5 text-lg" aria-label="Mobile">
        <a href="#how" onClick={() => setOpen(false)}>How it works</a>
        <a href="#calculator" onClick={() => setOpen(false)}>The math</a>
        <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
        <Button asChild><a href="/onboard">Protect a position</a></Button>
      </nav>
    </div>}
  </header>;
}

function Hero() {
  return <section className="container-frame grid gap-12 pb-20 pt-16 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:gap-20 lg:pb-28 lg:pt-24">
    <div>
      <Reveal><Badge>Event driven protection for Aave positions</Badge></Reveal>
      <Reveal delay={100}><h1 className="hero-gradient mt-6 max-w-3xl text-balance text-6xl font-light leading-none tracking-[-0.06em] sm:text-7xl">Stay above the line while you sleep.</h1></Reveal>
      <Reveal delay={180}><p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">Liquidation Guardian watches your health factor, chooses the smallest valid rescue, and sends the execution through KeeperHub before the auction takes your collateral.</p></Reveal>
      <Reveal delay={260}><div className="mt-8 flex flex-wrap items-center gap-4"><Button asChild size="lg"><a href="/onboard">Protect a position</a></Button><a href="#how" className="text-sm text-muted-foreground underline-offset-4 transition-colors duration-300 hover:text-foreground hover:underline">See how it works</a></div></Reveal>
      <Reveal delay={340}><div className="mt-12 flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-5 text-xs text-muted-foreground"><span><strong className="font-mono text-foreground">1.0</strong> liquidation floor</span><span><strong className="font-mono text-foreground">15s</strong> dashboard refresh</span><span><strong className="font-mono text-foreground">0</strong> withdrawal authority</span></div></Reveal>
    </div>
    <Reveal delay={160} className="lg:justify-self-end">
      <div className="rounded-xl border border-border bg-card p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-muted-foreground">Position signal</p><p className="mt-3 font-mono text-7xl font-light tracking-[-0.08em] text-foreground">1.42</p></div><Badge variant="success">Healthy</Badge></div>
        <div className="mt-10"><VigilLine hf={1.42} threshold={1.15} target={1.5} /></div>
        <div className="mt-8 grid grid-cols-2 gap-px border border-border bg-border"><Metric label="Collateral" value="$12,840" /><Metric label="Debt" value="$6,210" /><Metric label="Next check" value="15 sec" /><Metric label="Network" value="Sepolia" /></div>
        <div className="mt-6 flex items-center gap-3 border-t border-border pt-5 text-sm"><span className="size-2 rounded-full bg-healthy" /><span className="text-muted-foreground">Watching for a position event</span></div>
      </div>
    </Reveal>
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 font-mono text-sm text-foreground">{value}</p></div>; }

function Mechanism() {
  return <section id="how" className="border-y border-border bg-[#111111] py-20 lg:py-28"><div className="container-frame"><Reveal><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">The operating loop</p><h2 className="mt-5 max-w-3xl text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">Three signals. One calm decision.</h2></Reveal><div className="mt-14 grid gap-px border border-border bg-border lg:grid-cols-3"><MechanismItem n="01" title="Watch" text="A position event changes the risk picture. The Guardian reads the chain and refreshes the position." /><MechanismItem n="02" title="Decide" text="The model weighs the available rescue paths. Deterministic code checks the size and target." /><MechanismItem n="03" title="Execute" text="KeeperHub simulates first, then sends the bounded action onchain when the path is valid." /></div></div></section>;
}
function MechanismItem({ n, title, text }: { n: string; title: string; text: string }) { return <article className="bg-[#111111] p-6 sm:p-8"><span className="font-mono text-sm text-primary">{n}</span><h3 className="mt-16 text-2xl font-light">{title}</h3><p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">{text}</p></article>; }

function Benefits() {
  return <section className="container-frame py-20 lg:py-28"><div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr]"><Reveal><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Why it exists</p><h2 className="mt-5 max-w-md text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">The dangerous part is the delay.</h2></Reveal><div className="grid gap-px border border-border bg-border sm:grid-cols-2">{BENEFITS.map(([n, title, text]) => <Reveal key={n} as="div" delay={Number(n) * 60} className="bg-card p-6 sm:p-8"><span className="font-mono text-sm text-primary">{n}</span><h3 className="mt-12 text-2xl font-light leading-tight">{title}</h3><p className="mt-4 text-sm leading-relaxed text-muted-foreground">{text}</p></Reveal>)}</div></div></section>;
}

function HowItWorks() {
  return <section className="border-y border-border bg-[#111111] py-20 lg:py-28"><div className="container-frame"><Reveal><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Start in three moves</p><h2 className="mt-5 max-w-2xl text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">Connect once. Set the line. Keep watching.</h2></Reveal><div className="mt-14 grid gap-8 lg:grid-cols-3"><Step n="01" title="Connect your position" text="Add your KeeperHub key and wallet on the private onboarding page." /><Step n="02" title="Choose your line" text="Set when the Guardian acts and how high it restores the position." /><Step n="03" title="Get the signal" text="The dashboard shows the live health factor, rescue paths, and onchain history." /></div></div></section>;
}
function Step({ n, title, text }: { n: string; title: string; text: string }) { return <article className="border-t-2 border-primary pt-5"><p className="font-mono text-sm text-primary">{n}</p><h3 className="mt-10 text-2xl font-light">{title}</h3><p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">{text}</p></article>; }

function Tagline() { return <section className="container-frame py-24 lg:py-36"><TaglineReveal text="A liquidation happens in seconds. Your defense should not wait for a schedule." className="max-w-5xl text-5xl font-light leading-none tracking-[-0.06em] text-muted-foreground sm:text-7xl" /></section>; }

function RoiCalculator() {
  const [borrow, setBorrow] = useState(10000);
  const [hf, setHf] = useState(1.2);
  const result = useMemo(() => { const penalty = borrow * 0.08; const rescue = borrow * 0.03; const risk = hf <= 1 ? "Liquidating" : hf < 1.1 ? "Critical" : hf < 1.3 ? "Elevated" : "Moderate"; return { penalty, rescue, avoided: Math.max(0, penalty - rescue), risk }; }, [borrow, hf]);
  return <section id="calculator" className="container-frame scroll-mt-20 py-20 lg:py-28"><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:items-start"><Reveal><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">The math</p><h2 className="mt-5 max-w-md text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">See the cost of waiting.</h2><p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">Illustrative estimates show the penalty exposed against a smaller rescue action. Actual execution depends on the position and market.</p></Reveal><Reveal delay={100}><Card><CardHeader><CardTitle>Liquidation exposure</CardTitle></CardHeader><CardContent><div className="grid gap-6 sm:grid-cols-2"><label className="space-y-2 text-sm"><span className="text-muted-foreground">Borrow amount</span><input type="number" min={100} step={500} value={borrow} onChange={(event) => setBorrow(Math.max(0, Number(event.target.value)))} className="h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:border-primary focus-visible:outline-none" /></label><label className="space-y-2 text-sm"><span className="text-muted-foreground">Health factor</span><input type="number" min={0.5} max={2} step={0.05} value={hf} onChange={(event) => setHf(Math.min(2, Math.max(0.5, Number(event.target.value))))} className="h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:border-primary focus-visible:outline-none" /></label></div><div className="mt-8 grid gap-px border border-border bg-border sm:grid-cols-2"><Result label="Risk level" value={result.risk} tone={result.risk === "Critical" || result.risk === "Liquidating" ? "text-risk" : "text-watch"} /><Result label="Penalty exposed" value={`$${result.penalty.toFixed(0)}`} /><Result label="Estimated rescue" value={`$${result.rescue.toFixed(0)}`} /><Result label="Avoided" value={`$${result.avoided.toFixed(0)}`} tone="text-primary" /></div></CardContent></Card></Reveal></div></section>;
}
function Result({ label, value, tone = "text-foreground" }: { label: string; value: string; tone?: string }) { return <div className="bg-card p-5"><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-2 font-mono text-xl ${tone}`}>{value}</p></div>; }

function Security() { return <section className="border-y border-border bg-primary py-16 text-primary-foreground"><div className="container-frame grid gap-6 lg:grid-cols-[.7fr_1.3fr] lg:items-end"><p className="font-mono text-xs uppercase tracking-[0.2em]">The boundary</p><div><h2 className="max-w-3xl text-4xl font-light leading-tight tracking-[-0.04em] sm:text-5xl">Your key stays server side. Your withdrawals stay yours.</h2><p className="mt-5 max-w-2xl text-sm leading-relaxed text-primary-foreground/75">The Guardian is built to protect a position, not take custody. Every rescue path is simulated before it can be broadcast.</p></div></div></section>; }

function Faq() { const [open, setOpen] = useState(0); return <section id="faq" className="container-frame scroll-mt-20 py-20 lg:py-28"><div className="grid gap-12 lg:grid-cols-[.7fr_1.3fr]"><Reveal><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Questions</p><h2 className="mt-5 text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">Clear before you connect.</h2></Reveal><div className="border-t border-border">{FAQS.map(([question, answer], index) => <div key={question} className="border-b border-border"><button type="button" aria-expanded={open === index} onClick={() => setOpen(open === index ? -1 : index)} className="flex w-full items-center justify-between gap-5 py-5 text-left text-lg font-light"><span>{question}</span><span className="font-mono text-primary">{open === index ? "−" : "+"}</span></button>{open === index && <p className="max-w-2xl pb-5 text-sm leading-relaxed text-muted-foreground">{answer}</p>}</div>)}</div></div></section>; }

function FinalCta() { return <section className="container-frame pb-24 pt-4 lg:pb-36"><div className="border border-primary bg-[#1a0500] p-8 sm:p-12 lg:flex lg:items-end lg:justify-between lg:gap-12"><div><p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Start before the line</p><h2 className="mt-5 max-w-2xl text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">Give your position a watcher.</h2></div><Button asChild size="lg" className="mt-8 shrink-0 bg-white text-black hover:bg-white/85 lg:mt-0"><a href="/onboard">Protect a position</a></Button></div></section>; }
