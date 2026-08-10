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
import { Card } from "../components/ui/card.js";

const REFRESH_MS = 15_000;
const HfHistoryChart = lazy(() =>
  import("../components/HfHistoryChart.js").then((module) => ({
    default: module.HfHistoryChart,
  })),
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
      <div className="h-8 w-8 animate-spin rounded-[2rem] p-1.5 bg-black/10 border border-white/5" />
    </div>
  );
}

function Dashboard({
  session,
  onDisconnect,
}: {
  session?: {
    telegramConnected?: boolean;
    telegramUsername?: string | null;
    paused?: boolean;
    hfThreshold?: number;
    hfTarget?: number;
  };
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
    onSuccess: () => {
      void sessionRefetch();
    },
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
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      {/* Noise overlay - fixed, pointer-events-none */}
      <div className="noise-overlay" aria-hidden="true" />
      <nav className="flex flex-wrap items-center justify-between gap-6 border-b border-border px-6 py-4 sm:px-8 sm:py-6">
        <a href="/" className="text-lg font-bold tracking-tight hover:text-primary">
          Liquidation<span className="text-primary">Guardian</span>
        </a>
        <div className="flex items-center gap-3 sm:gap-4">
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            onClick={() => pause.mutate(!paused)}
            disabled={pause.isPending}
            aria-label={paused ? "Resume watching" : "Pause watching"}
            className="magneticIcon"
          >
            {paused ? "Resume" : "Pause"}
            <svg className="h-4 w-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 5l-5 5h3v7h4v-7h3z" />
            </svg>
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

      <main className="mx-auto max-w-[1440px] px-6 py-6">
        {confirmingStop && (
          <Card className="mt-6">
            <div>
              <p id="stop-title" className="font-semibold text-foreground">Delete this Guardian?</p>
              <p className="text-sm text-muted-foreground">
                Monitoring stops and the stored KeeperHub credential is permanently removed.
              </p>
            </div>
            <div className="flex gap-3 mt-4">
              <Button variant="outline" size="sm" onClick={() => setConfirmingStop(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
                {stop.isPending ? "Deleting…" : "Delete Guardian"}
              </Button>
            </div>
          </Card>
        )}

        {paused && (
          <Card className="mt-6">
            The agent is paused. It is not watching this position.
          </Card>
        )}

        {status.isError && (
          <Card className="mt-6">
            {status.error instanceof Error ? status.error.message : "Position data is temporarily unavailable."}
          </Card>
        )}

        {status.isLoading ? (
          <PositionSkeleton />
        ) : s ? (
          <>
            <HealthFactorHero status={s} />

            {/* Live threshold editor */}
            <Card className="mt-6">
              {editingThresholds ? (
                <form
                  className="flex flex-wrap items-end gap-6"
                  onSubmit={(e) => {
                    e.preventDefault();
                    thresholds.mutate({ t: Number(t), g: Number(g) });
                  }}
                >
                  <div className="space-y-3">
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
                  <div className="space-y-3">
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
                  <Button
                    type="submit"
                    size="sm"
                    disabled={thresholds.isPending || !(Number(g) > Number(t))}
                  >
                    {thresholds.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingThresholds(false)}
                  >
                    Cancel
                  </Button>
                  {thresholds.isError && (
                    <p className="text-sm text-risk">
                      {thresholds.error instanceof Error ? thresholds.error.message : "Couldn't save"}
                    </p>
                  )}
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-6">
                  <p className="text-sm text-muted-foreground">
                    Act below <span className="font-mono font-semibold text-watch">{s.hfThreshold.toFixed(2)}</span>
                    {" · "}restore to <span className="font-mono font-semibold text-healthy">{s.hfTarget.toFixed(2)}</span>
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setEditingThresholds(true)}>
                    Edit thresholds
                  </Button>
                </div>
              )}
            </Card>

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <Card>
                <PositionCard status={s} />
              </Card>
              <Card>
                <RescueOptionsCard status={s} />
              </Card>
            </div>
            <div className="mt-6">
              <Suspense fallback={<ChartPlaceholder />}>
                <HfHistoryChart />
              </Suspense>
            </div>
            <div className="mt-6">
              <RescueHistory rescues={rescues.data ?? []} error={rescues.isError} onRetry={() => void rescues.refetch()} />
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
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Card>
            <TelegramLink connected={session?.telegramConnected} boundUsername={session?.telegramUsername} onChanged={() => void onDisconnect()} />
          </Card>
        </div>
      </main>
    </div>
  );
}

/* ── Skeleton shaped like the real layout (B9 loading state). */
function PositionSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading position">
      <Card>
        <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
        <div className="mt-4 h-12 w-44 animate-pulse rounded bg-secondary" />
        <div className="mt-5 h-3 w-full animate-pulse rounded bg-secondary/60" />
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="h-[64px]">
          <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
        </Card>
        <Card className="h-[64px]">
          <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
        </Card>
      </div>
    </div>
  );
}

function ChartPlaceholder() {
  return (
    <Card className="h-[100px]">
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