import { useEffect, useState } from "react";
import { openSession, resumeSession, type Credentials, type SessionConfig } from "../api.js";
import { initTelegram, isInTelegram, telegramInitData } from "../telegram.js";
import { BrandMark } from "./BrandMark.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Slider } from "./ui/slider.js";
import { cn } from "../lib/utils.js";

export function Onboarding({ onConnected }: { onConnected?: (config: SessionConfig) => void }) {
  const [mode, setMode] = useState<"connect" | "resume">("connect");
  const [apiKey, setApiKey] = useState("");
  const [wallet, setWallet] = useState("");
  const [profile, setProfile] = useState<"conservative" | "efficient">("conservative");
  const [threshold, setThreshold] = useState(1.6);
  const [target, setTarget] = useState(2.0);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const inTelegram = isInTelegram();
  const [resumeWallet, setResumeWallet] = useState("");
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  useEffect(() => { initTelegram(); }, []);

  function pickProfile(value: "conservative" | "efficient") {
    setProfile(value);
    if (value === "conservative") { setThreshold(1.6); setTarget(2); }
    else { setThreshold(1.1); setTarget(1.5); }
  }
  const targetFloor = Math.round((threshold + 0.1) * 100) / 100;
  function go(config: SessionConfig) { if (onConnected) onConnected(config); else window.location.href = "/dashboard"; }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setConnectError(null);
    try {
      const creds: Credentials = { keeperHubApiKey: apiKey.trim(), wallet: wallet.trim(), chainId: "11155111", hfThreshold: threshold, hfTarget: Math.max(target, targetFloor), ...(inTelegram ? { initData: telegramInitData() } : {}) };
      const { config } = await openSession(creds); if (config) go(config);
    } catch (err) { setConnectError(err instanceof Error ? err.message : "Connection failed. Please try again."); }
    finally { setBusy(false); }
  }
  async function resume(event: React.FormEvent) {
    event.preventDefault(); setResumeBusy(true); setResumeError(null);
    try {
      const { config } = await resumeSession({ wallet: resumeWallet.trim(), chainId: "11155111", ...(inTelegram ? { initData: telegramInitData() } : {}) });
      if (config) go(config);
    } catch (err) { setResumeError(err instanceof Error ? err.message : "We could not find that wallet."); }
    finally { setResumeBusy(false); }
  }

  return <div className="min-h-screen bg-background text-foreground"><header className="border-b border-border"><div className="container-frame flex h-16 items-center justify-between"><a href="/" aria-label="Liquidation Guardian home"><BrandMark /></a><a href="/" className="text-sm text-muted-foreground transition-colors duration-300 hover:text-foreground">Back to home</a></div></header><main className="container-frame grid gap-12 py-12 lg:grid-cols-[.8fr_1.2fr] lg:items-start lg:gap-24 lg:py-24"><section className="lg:sticky lg:top-24"><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Private onboarding</p><h1 className="mt-5 max-w-xl text-5xl font-light leading-none tracking-[-0.05em] sm:text-6xl">Put a watcher on the position.</h1><p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">Connect once, choose your risk line, and keep the dashboard close when the market moves.</p><div className="mt-12 grid max-w-md gap-px border border-border bg-border sm:grid-cols-2"><Info label="Network" value="Sepolia" /><Info label="Execution" value="Simulate first" /><Info label="Key storage" value="Server only" /><Info label="Control" value="Pause anytime" /></div></section><section className="rounded-xl border border-border bg-card p-5 sm:p-8"><div className="flex items-center justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-muted-foreground">Your position</p><h2 className="mt-2 text-2xl font-light">Connect or resume</h2></div><span className="size-3 rounded-full bg-primary" /></div><div className="mt-8 grid grid-cols-2 gap-1 rounded-full border border-border bg-background p-1"><button type="button" onClick={() => setMode("connect")} className={cn("rounded-full py-2 text-sm transition-colors duration-300", mode === "connect" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>New position</button><button type="button" onClick={() => setMode("resume")} className={cn("rounded-full py-2 text-sm transition-colors duration-300", mode === "resume" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>Resume monitoring</button></div><div className="mt-8">{mode === "resume" ? <ResumeForm wallet={resumeWallet} setWallet={setResumeWallet} error={resumeError} busy={resumeBusy} onSubmit={resume} /> : <ConnectForm apiKey={apiKey} setApiKey={setApiKey} wallet={wallet} setWallet={setWallet} profile={profile} pickProfile={pickProfile} threshold={threshold} setThreshold={setThreshold} target={target} setTarget={setTarget} targetFloor={targetFloor} error={connectError} busy={busy} onSubmit={submit} />}</div></section></main></div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 font-mono text-sm">{value}</p></div>; }

function ResumeForm({ wallet, setWallet, error, busy, onSubmit }: { wallet: string; setWallet: (v: string) => void; error: string | null; busy: boolean; onSubmit: (e: React.FormEvent) => void }) { return <form onSubmit={onSubmit} className="space-y-6"><div className="space-y-2"><Label htmlFor="resume-wallet">Wallet address</Label><Input id="resume-wallet" type="text" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} autoComplete="off" spellCheck={false} required /><p className="text-xs text-muted-foreground">The server finds your stored position. No key needed.</p></div>{error && <Alert>{error}</Alert>}<Button type="submit" className="w-full" disabled={busy}>{busy ? "Checking…" : "Resume monitoring"}</Button></form>; }

function ConnectForm({ apiKey, setApiKey, wallet, setWallet, profile, pickProfile, threshold, setThreshold, target, setTarget, targetFloor, error, busy, onSubmit }: { apiKey: string; setApiKey: (v: string) => void; wallet: string; setWallet: (v: string) => void; profile: "conservative" | "efficient"; pickProfile: (v: "conservative" | "efficient") => void; threshold: number; setThreshold: (v: number) => void; target: number; setTarget: (v: number) => void; targetFloor: number; error: string | null; busy: boolean; onSubmit: (e: React.FormEvent) => void }) { return <form onSubmit={onSubmit} className="space-y-6"><div className="grid gap-5 sm:grid-cols-2"><div className="space-y-2 sm:col-span-2"><Label htmlFor="kh">KeeperHub API key</Label><Input id="kh" type="password" placeholder="kh_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" required /></div><div className="space-y-2 sm:col-span-2"><Label htmlFor="wallet">Wallet address</Label><Input id="wallet" type="text" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} autoComplete="off" spellCheck={false} required /></div></div><div className="space-y-3"><Label>Defense profile</Label><div className="grid gap-3 sm:grid-cols-2"><ProfileCard title="Conservative" body="Act early, restore high" active={profile === "conservative"} onClick={() => pickProfile("conservative")} /><ProfileCard title="Capital efficient" body="Ride closer to the edge" active={profile === "efficient"} onClick={() => pickProfile("efficient")} /></div></div><div className="space-y-6 border-t border-border pt-6"><div className="space-y-3"><div className="flex items-center justify-between text-sm"><Label>Act below</Label><span className="font-mono text-accent">{threshold.toFixed(2)}</span></div><Slider aria-label="Act below health factor" min={1.05} max={2.5} step={0.05} value={[threshold]} onValueChange={([value]) => { setThreshold(value); if (target < value + 0.1) setTarget(Math.round((value + 0.5) * 100) / 100); }} /></div><div className="space-y-3"><div className="flex items-center justify-between text-sm"><Label>Restore to</Label><span className="font-mono text-accent">{Math.max(target, targetFloor).toFixed(2)}</span></div><Slider aria-label="Restore health factor to" min={targetFloor} max={3} step={0.05} value={[Math.max(target, targetFloor)]} onValueChange={([value]) => setTarget(value)} /></div></div>{error && <Alert>{error}</Alert>}<Button type="submit" disabled={busy} className="w-full" size="lg">{busy ? "Connecting…" : "Connect and watch"}</Button><p className="text-xs leading-relaxed text-muted-foreground">Your key goes to the server over HTTPS and is encrypted at rest. This page never asks you to connect or sign a wallet.</p></form>; }

function Alert({ children }: { children: React.ReactNode }) { return <div role="alert" className="border border-risk/40 bg-risk/10 p-3 text-sm text-risk">{children}</div>; }
function ProfileCard({ title, body, active, onClick }: { title: string; body: string; active: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} aria-pressed={active} className={cn("rounded-lg border p-4 text-left transition-colors duration-300", active ? "border-primary bg-primary/10" : "border-border bg-background hover:border-[#555]")}><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs text-muted-foreground">{body}</span></button>; }
