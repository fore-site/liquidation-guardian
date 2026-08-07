import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  closeSession,
  getRescues,
  getSession,
  getStatus,
  type Rescue,
} from "../api.js";
import { Onboarding } from "../components/Onboarding.js";
import { HealthFactorHero } from "../components/HealthFactorHero.js";
import { PositionCard } from "../components/PositionCard.js";
import { RescueOptionsCard } from "../components/RescueOptionsCard.js";
import { RescueHistory } from "../components/RescueHistory.js";

const REFRESH_MS = 15_000;

export const Route = createFileRoute("/app")({
  component: App,
});

/**
 * The monitoring dashboard — the one in-app page (session-gated). Uses TanStack
 * Query for the 15s poll (refetchInterval) and mutations for controls; shows
 * onboarding inline when not connected (Telegram Mini App flow).
 */
function App() {
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: Infinity });

  // Session-gate: null = still loading; false = not connected; true = connected.
  const authed = session.data?.authenticated ?? false;
  const ready = session.status !== "pending";

  if (!ready) return <div className="app center">Loading…</div>;
  if (!authed) return <Onboarding onConnected={() => void session.refetch()} />;
  return <Dashboard onDisconnect={() => void session.refetch()} />;
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void }) {
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

  const s = status.data;

  return (
    <div className="app">
      <header className="header">
        <a href="/" className="header-home" title="Back to home">
          Liquidation Guardian
        </a>
        <div className="header-actions">
          <button className="refresh" onClick={() => void status.refetch()} disabled={status.isFetching}>
            {status.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <button className="ghost" onClick={() => disconnect.mutate()}>
            Disconnect
          </button>
        </div>
      </header>

      {status.isError && (
        <div className="banner error">
          {status.error instanceof Error ? status.error.message : "Failed to load"} — is the API
          server running?
        </div>
      )}

      {status.isLoading ? (
        <div className="banner">Loading position…</div>
      ) : s ? (
        <>
          <HealthFactorHero status={s} />
          <div className="grid">
            <PositionCard status={s} />
            <RescueOptionsCard status={s} />
          </div>
          <RescueHistory rescues={rescues.data ?? []} />
          <footer className="footer">
            <span>
              {short(s.wallet)} · chain {s.chainId}
            </span>
            <span>updated {new Date(s.updatedAt).toLocaleTimeString()}</span>
          </footer>
        </>
      ) : null}
    </div>
  );
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
