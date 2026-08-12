import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { closeSession, getAudit, getRescues, getSession, getStatus, setPaused, stopWatching, updateThresholds } from "../api.js";
import { BrandMark } from "../components/BrandMark.js";
import { AuditTimeline } from "../components/AuditTimeline.js";
import { HealthFactorHero } from "../components/HealthFactorHero.js";
import { PositionCard } from "../components/PositionCard.js";
import { RescueOptionsCard } from "../components/RescueOptionsCard.js";
import { RescueHistory } from "../components/RescueHistory.js";
import { TelegramLink } from "../components/TelegramLink.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Card } from "../components/ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.js";

const REFRESH_MS = 15_000;
const HfHistoryChart = lazy(() => import("../components/HfHistoryChart.js").then((module) => ({ default: module.HfHistoryChart })));

export const Route = createFileRoute("/dashboard")({ component: App });

function App() {
  const navigate = useNavigate();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: Infinity });
  const ready = session.status !== "pending";
  const authed = session.data?.authenticated ?? false;
  useEffect(() => { if (ready && !authed) void navigate({ to: "/onboard" }); }, [ready, authed, navigate]);
  if (!ready || !authed) return <ShellLoading />;
  return <Dashboard session={session.data?.config} onDisconnect={() => void session.refetch()} />;
}

function ShellLoading() { return <div className="flex min-h-screen items-center justify-center bg-background"><div className="size-8 animate-pulse rounded-full bg-primary" aria-label="Loading dashboard" /></div>; }

function Dashboard({ session, onDisconnect }: { session?: { wallet?: string; chainId?: string; telegramConnected?: boolean; telegramUsername?: string | null; paused?: boolean; hfThreshold?: number; hfTarget?: number }; onDisconnect: () => void }) {
  const queryClient = useQueryClient();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [editingThresholds, setEditingThresholds] = useState(false);
  const status = useQuery({ queryKey: ["status"], queryFn: getStatus, refetchInterval: REFRESH_MS });
  const rescues = useQuery({ queryKey: ["rescues"], queryFn: getRescues, refetchInterval: REFRESH_MS });
  const audit = useQuery({ queryKey: ["audit"], queryFn: getAudit, refetchInterval: REFRESH_MS });
  const disconnect = useMutation({ mutationFn: closeSession, onSuccess: () => { void queryClient.clear(); onDisconnect(); } });
  const stop = useMutation({ mutationFn: stopWatching, onSuccess: () => { void queryClient.clear(); onDisconnect(); } });
  const pause = useMutation({ mutationFn: (value: boolean) => setPaused(value), onSuccess: () => void sessionRefetch() });
  const thresholds = useMutation({ mutationFn: (value: { t: number; g: number }) => updateThresholds(value.t, value.g), onSuccess: () => { void sessionRefetch(); setEditingThresholds(false); } });
  const [t, setT] = useState(session?.hfThreshold ?? 1.15);
  const [g, setG] = useState(session?.hfTarget ?? 1.5);
  useEffect(() => { if (session?.hfThreshold != null) setT(session.hfThreshold); if (session?.hfTarget != null) setG(session.hfTarget); }, [session?.hfThreshold, session?.hfTarget]);
  function sessionRefetch() { void queryClient.invalidateQueries({ queryKey: ["session"] }); void queryClient.invalidateQueries({ queryKey: ["status"] }); onDisconnect(); }
  const paused = session?.paused === true;
  const s = status.data;

  return <div className="min-h-screen bg-background text-foreground"><header className="border-b border-border"><div className="container-frame flex min-h-16 flex-wrap items-center justify-between gap-4 py-3"><a href="/" aria-label="Liquidation Guardian home"><BrandMark /></a><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden font-mono sm:inline">{session?.wallet ? short(session.wallet) : "wallet"}</span><span className="rounded-full border border-border px-2 py-1">Sepolia</span><Button variant={paused ? "default" : "outline"} size="sm" onClick={() => pause.mutate(!paused)} disabled={pause.isPending}>{paused ? "Resume" : "Pause"}</Button><Button variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching} aria-label="Refresh position"><RefreshIcon spinning={status.isFetching} /><span className="hidden sm:inline">Refresh</span></Button><Button variant="ghost" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Log out</Button><Button variant="destructive" size="sm" onClick={() => setConfirmingStop(true)} disabled={stop.isPending || confirmingStop}>Stop watching</Button></div></div></header><main className="container-frame py-8 lg:py-12">{paused && <div className="mb-6 border border-watch/40 bg-watch/10 p-4 text-sm text-watch">Monitoring is paused. The Guardian is not watching this position.</div>}{status.isError && <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-4 border border-risk/40 bg-risk/10 p-4 text-sm text-risk"><span>{status.error instanceof Error ? status.error.message : "Position data is temporarily unavailable."}</span><button type="button" className="underline" onClick={() => void status.refetch()}>Retry</button></div>}<div className="mb-10 flex flex-wrap items-end justify-between gap-4"><div><p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Live position</p><h1 className="mt-3 text-4xl font-light tracking-[-0.04em] sm:text-5xl">Your protection line</h1></div><p className="text-sm text-muted-foreground">Updates every 15 seconds</p></div>{status.isLoading ? <PositionSkeleton /> : s ? <><HealthFactorHero status={s} /><Card className="mt-6 p-6">{editingThresholds ? <form className="flex flex-wrap items-end gap-4" onSubmit={(event) => { event.preventDefault(); thresholds.mutate({ t: Number(t), g: Number(g) }); }}><div className="space-y-2"><Label htmlFor="thr">Act below</Label><Input id="thr" type="number" min={1.01} max={5} step={0.05} value={t} onChange={(event) => setT(Number(event.target.value))} className="w-28" /></div><div className="space-y-2"><Label htmlFor="trg">Restore to</Label><Input id="trg" type="number" min={1.1} max={5} step={0.05} value={g} onChange={(event) => setG(Number(event.target.value))} className="w-28" /></div><Button type="submit" size="sm" disabled={thresholds.isPending || !(Number(g) > Number(t))}>{thresholds.isPending ? "Saving…" : "Save"}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setEditingThresholds(false)}>Cancel</Button>{thresholds.isError && <p className="text-sm text-risk">{thresholds.error instanceof Error ? thresholds.error.message : "Could not save changes."}</p>}</form> : <div className="flex flex-wrap items-center justify-between gap-4"><p className="text-sm text-muted-foreground">Act below <span className="font-mono text-watch">{s.hfThreshold.toFixed(2)}</span><span className="mx-2">·</span>restore to <span className="font-mono text-healthy">{s.hfTarget.toFixed(2)}</span></p><Button variant="outline" size="sm" onClick={() => setEditingThresholds(true)}>Edit thresholds</Button></div>}</Card><div className="mt-6 grid gap-6 lg:grid-cols-2"><PositionCard status={s} /><RescueOptionsCard status={s} /></div><div className="mt-6"><Suspense fallback={<ChartPlaceholder />}><HfHistoryChart /></Suspense></div><div className="mt-6"><RescueHistory rescues={rescues.data ?? []} error={rescues.isError} onRetry={() => void rescues.refetch()} /></div><div className="mt-6"><AuditTimeline events={audit.data ?? []} error={audit.isError} onRetry={() => void audit.refetch()} /></div></> : null}<div className="mt-6"><TelegramLink connected={session?.telegramConnected} boundUsername={session?.telegramUsername} onChanged={() => void onDisconnect()} /></div>{s && <footer className="mt-8 flex flex-wrap justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground"><span className="font-mono">{short(s.wallet)} · chain {s.chainId}</span><span>Updated {new Date(s.updatedAt).toLocaleTimeString()}</span></footer>}</main><Dialog open={confirmingStop} onOpenChange={setConfirmingStop}><DialogContent><DialogHeader><DialogTitle>Stop watching this position?</DialogTitle><DialogDescription>This permanently removes the stored Guardian and encrypted KeeperHub credential. Monitoring will stop.</DialogDescription></DialogHeader><div className="mt-6 flex justify-end gap-3"><Button variant="ghost" onClick={() => setConfirmingStop(false)}>Cancel</Button><Button variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>{stop.isPending ? "Deleting…" : "Stop watching"}</Button></div></DialogContent></Dialog></div>;
}

function PositionSkeleton() { return <div className="space-y-6" aria-label="Loading position"><div className="h-56 animate-pulse rounded-xl border border-border bg-card" /><div className="grid gap-6 lg:grid-cols-2"><div className="h-96 animate-pulse rounded-xl border border-border bg-card" /><div className="h-96 animate-pulse rounded-xl border border-border bg-card" /></div></div>; }
function ChartPlaceholder() { return <div className="h-72 animate-pulse rounded-xl border border-border bg-card" aria-label="Loading health factor history" />; }
function RefreshIcon({ spinning }: { spinning?: boolean }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`size-4 ${spinning ? "animate-spin" : ""}`}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>; }
function short(address: string) { return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address; }
