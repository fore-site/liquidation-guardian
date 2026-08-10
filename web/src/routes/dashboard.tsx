import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  closeSession,
  getRescues,
  getSession,
  getStatus,
  setPaused,
  stopWatching,
  updateThresholds,
} from "../api.js";
import { HealthFactorHero } from "../components/HealthFactorHero.js";
import { PositionCard } from "../components/PositionCard.js";
import { RescueOptionsCard } from "../components/RescueOptionsCard.js";
import { RescueHistory } from "../components/RescueHistory.js";
import { TelegramLink } from "../components/TelegramLink.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

const REFRESH_MS = 15_000;
const HfHistoryChart = lazy(() =>
  import("../components/HfHistoryChart.js").then((module) => ({ default: module.HfHistoryChart })),
);

export const Route = createFileRoute("/dashboard")({
  component: App,
});

/**
 * The monitoring dashboard — the one in-app page (session-gated). Uses TanStack
 * Query for the 15s poll (refetchInterval) and mutations for controls.
 * Unauthenticated visitors are redirected to /onboard (onboarding) rather than
 * shown the form inline on this URL.
 */
function App() {
  const navigate = useNavigate();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: Infinity });

  const authed = session.data?.authenticated ?? false;
  const ready = session.status !== "pending";

  useEffect(() => {
    if (ready && !authed) void navigate({ to: "/onboard" });
  }, [ready, authed, navigate]);

  if (!ready) return <ShellLoading />;
  if (!authed) return <ShellLoading />;
  return <Dashboard session={session.data?.config} onDisconnect={() => void session.refetch()} />;
}

function ShellLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-secondary border-t-accent" />
    </div>
  );
}

function Dashboard({
  session,
  onDisconnect,
}: {
  session?: { telegramConnected?: boolean; telegramUsername?: string | null; paused?: boolean; hfThreshold?: number; hfTarget?: number };
  onDisconnect: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [editingThresholds, setEditingThresholds] = useState(false);

  const status = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: REFRESH_MS,
  });
  const rescues = useQuery({
    queryKey: ["rescues"],
    queryFn: getRescues,
    refetchInterval: REFRESH_MS,
  });

  const disconnect = useMutation({
    mutationFn: closeSession,
    onSuccess: () => {
      void queryClient.clear();
      onDisconnect();
    },
  });

  const stop = useMutation({
    mutationFn: stopWatching,
    onSuccess: () => {
      void queryClient.clear();
      onDisconnect();
    },
  });

  const pause = useMutation({
    mutationFn: (paused: boolean) => setPaused(paused),
    onSuccess: () => void sessionRefetch(),
  });
  const thresholds = useMutation({
    mutationFn: (v: { t: number; g: number }) => updateThresholds(v.t, v.g),
    onSuccess: () => {
      void sessionRefetch();
      setEditingThresholds(false);
    },
  });

  // Local threshold editor state (init from the session config).
  const [t, setT] = useState(session?.hfThreshold ?? 1.15);
  const [g, setG] = useState(session?.hfTarget ?? 1.5);
  useEffect(() => {
    if (session?.hfThreshold != null) setT(session.hfThreshold);
    if (session?.hfTarget != null) setG(session.hfTarget);
  }, [session?.hfThreshold, session?.hfTarget]);

  function sessionRefetch() {
    void queryClient.invalidateQueries({ queryKey: ["session"] });
    void queryClient.invalidateQueries({ queryKey: ["status"] });
    onDisconnect();
  }

  const paused = session?.paused === true;
  const s = status.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <a href="/" className="text-lg font-bold tracking-tight hover:text-primary">
          Liquidation<span className="text-primary">Guardian</span>
        </a>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={() => pause.mutate(!paused)}
            disabled={pause.isPending}
            aria-label={paused ? "Resume watching" : "Pause watching"}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching} aria-label="Refresh position">
            <RefreshIcon spinning={status.isFetching} />
            <span className="hidden sm:inline">{status.isFetching ? "Refreshing…" : "Refresh"}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            <LogOutIcon />
            <span className="hidden sm:inline">Log out</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirmingStop(true)} disabled={stop.isPending || confirmingStop} aria-label="Stop watching">
            <OctagonAlertIcon />
            <span className="hidden sm:inline">Stop watching</span>
          </Button>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {confirmingStop && (
          <div role="alertdialog" aria-labelledby="stop-title" className="mb-4 flex flex-col gap-3 rounded-lg border border-risk/40 bg-risk/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p id="stop-title" className="font-semibold text-foreground">Delete this Guardian?</p>
              <p className="text-sm text-muted-foreground">Monitoring stops and the stored KeeperHub credential is permanently removed.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmingStop(false)}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
                {stop.isPending ? "Deleting…" : "Delete Guardian"}
              </Button>
            </div>
          </div>
        )}

        {paused && (
          <div className="mb-4 rounded-lg border border-watch/40 bg-watch/10 p-3 text-sm text-watch">
            The agent is paused. It is not watching this position.
          </div>
        )}

        {status.isError && (
          <div className="mb-4 rounded-lg border border-risk/40 bg-risk/10 p-3 text-sm text-risk">
            {status.error instanceof Error ? status.error.message : "Position data is temporarily unavailable."}
          </div>
        )}

        {status.isLoading ? (
          <PositionSkeleton />
        ) : s ? (
          <>
            <HealthFactorHero status={s} />

            {/* Live threshold editor */}
            <div className="mt-4 rounded-xl border border-border bg-card p-5">
              {editingThresholds ? (
                <form
                  className="flex flex-wrap items-end gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    thresholds.mutate({ t: Number(t), g: Number(g) });
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="thr">Act below</Label>
                    <Input
                      id="thr"
                      type="number"
                      min={1.01}
                      max={5}
                      step={0.05}
                      value={t}
                      onChange={(e) => setT(Number(e.target.value))}
                      className="w-28"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="trg">Restore to</Label>
                    <Input
                      id="trg"
                      type="number"
                      min={1.1}
                      max={5}
                      step={0.05}
                      value={g}
                      onChange={(e) => setG(Number(e.target.value))}
                      className="w-28"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={thresholds.isPending || !(Number(g) > Number(t))}>
                    {thresholds.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingThresholds(false)}>
                    Cancel
                  </Button>
                  {thresholds.isError && (
                    <p className="text-sm text-risk">{thresholds.error instanceof Error ? thresholds.error.message : "Couldn't save"}</p>
                  )}
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    Act below <span className="font-mono font-semibold text-watch">{s.hfThreshold.toFixed(2)}</span>
                    {" · "}restore to <span className="font-mono font-semibold text-healthy">{s.hfTarget.toFixed(2)}</span>
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setEditingThresholds(true)}>
                    Edit thresholds
                  </Button>
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <PositionCard status={s} />
              <RescueOptionsCard status={s} />
            </div>
            <div className="mt-4">
              <Suspense fallback={<ChartPlaceholder />}>
                <HfHistoryChart />
              </Suspense>
            </div>
            <div className="mt-4">
              <RescueHistory
                rescues={rescues.data ?? []}
                error={rescues.isError}
                onRetry={() => void rescues.refetch()}
              />
            </div>
            <footer className="mt-6 flex justify-between text-xs text-muted-foreground">
              <span className="font-mono">
                {short(s.wallet)} · chain {s.chainId}
              </span>
              <span>updated {new Date(s.updatedAt).toLocaleTimeString()}</span>
            </footer>
          </>
        ) : null}

        {/* Always visible — Telegram binding is independent of the position read. */}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <TelegramLink connected={session?.telegramConnected} boundUsername={session?.telegramUsername} onChanged={() => void onDisconnect()} />
        </div>
      </main>
    </div>
  );
}

/** Skeleton shaped like the real layout (B9 loading state). */
function PositionSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading position">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="h-3 w-24 animate-pulse rounded bg-secondary" />
        <div className="mt-3 h-10 w-40 animate-pulse rounded bg-secondary" />
        <div className="mt-5 h-2 w-full animate-pulse rounded bg-secondary/60" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    </div>
  );
}

function ChartPlaceholder() {
  return (
    <div className="rounded-xl border border-border bg-card p-6" aria-label="Loading health factor history">
      <div className="h-4 w-44 animate-pulse rounded bg-secondary" />
      <div className="mt-6 h-36 animate-pulse rounded-lg bg-secondary/60" />
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`size-4 ${spinning ? "animate-spin" : ""}`}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function LogOutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
function OctagonAlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
