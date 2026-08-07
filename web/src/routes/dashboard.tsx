import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  closeSession,
  getRescues,
  getSession,
  getStatus,
  stopWatching,
  type Rescue,
} from "../api.js";
import { HealthFactorHero } from "../components/HealthFactorHero.js";
import { PositionCard } from "../components/PositionCard.js";
import { RescueOptionsCard } from "../components/RescueOptionsCard.js";
import { RescueHistory } from "../components/RescueHistory.js";
import { HfHistoryChart } from "../components/HfHistoryChart.js";
import { TelegramLink } from "../components/TelegramLink.js";
import { Button } from "../components/ui/button.js";

const REFRESH_MS = 15_000;

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

  if (!ready) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  if (!authed) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  return <Dashboard session={session.data?.config} onDisconnect={() => void session.refetch()} />;
}

function Dashboard({
  session,
  onDisconnect,
}: {
  session?: { telegramUsername?: string | null };
  onDisconnect: () => void;
}) {
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: REFRESH_MS,
  });
  const rescues = useQuery({
    queryKey: ["rescues"],
    queryFn: () => getRescues().catch(() => [] as Rescue[]),
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

  function confirmStop() {
    if (window.confirm("Stop watching and delete all stored data? You'll need to onboard again.")) {
      stop.mutate();
    }
  }

  const s = status.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="flex items-center justify-between border-b border-border px-6 py-4">
        <a href="/" className="text-lg font-bold tracking-tight hover:text-primary">
          Liquidation<span className="text-primary">Guardian</span>
        </a>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Log out
          </Button>
          <Button variant="destructive" size="sm" onClick={confirmStop} disabled={stop.isPending}>
            Stop watching
          </Button>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-6">
        {status.isError && (
          <div className="mb-4 rounded-lg border border-risk/40 bg-risk/10 p-3 text-sm text-risk">
            {status.error instanceof Error ? status.error.message : "Failed to load"} — is the API
            server running?
          </div>
        )}

        {status.isLoading ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            Loading position…
          </div>
        ) : s ? (
          <>
            <HealthFactorHero status={s} />
            <div className="grid gap-4 md:grid-cols-2">
              <PositionCard status={s} />
              <RescueOptionsCard status={s} />
            </div>
            <div className="mt-4">
              <HfHistoryChart />
            </div>
            <div className="mt-4">
              <RescueHistory rescues={rescues.data ?? []} />
            </div>
            <footer className="mt-6 flex justify-between text-xs text-muted-foreground">
              <span>
                {short(s.wallet)} · chain {s.chainId}
              </span>
              <span>updated {new Date(s.updatedAt).toLocaleTimeString()}</span>
            </footer>
          </>
        ) : null}

        {/* Always visible — Telegram binding is independent of the position read. */}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <TelegramLink boundUsername={session?.telegramUsername} onChanged={() => void onDisconnect()} />
        </div>
      </main>
    </div>
  );
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
