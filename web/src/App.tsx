import { useCallback, useEffect, useState } from "react";
import {
  closeSession,
  getRescues,
  getSession,
  getStatus,
  type Rescue,
  type SessionConfig,
  type Status,
} from "./api.js";
import { Onboarding } from "./components/Onboarding.js";
import { HealthFactorHero } from "./components/HealthFactorHero.js";
import { PositionCard } from "./components/PositionCard.js";
import { RescueOptionsCard } from "./components/RescueOptionsCard.js";
import { RescueHistory } from "./components/RescueHistory.js";

const REFRESH_MS = 15_000;

export function App() {
  // undefined = still checking the session; null = not connected; config = connected.
  const [config, setConfig] = useState<SessionConfig | null | undefined>(undefined);

  useEffect(() => {
    getSession()
      .then((s) => setConfig(s.authenticated && s.config ? s.config : null))
      .catch(() => setConfig(null));
  }, []);

  if (config === undefined) {
    return <div className="app center">Loading…</div>;
  }
  if (config === null) {
    return <Onboarding onConnected={setConfig} />;
  }
  return <Dashboard onDisconnect={() => setConfig(null)} />;
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [rescues, setRescues] = useState<Rescue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      // Status is the critical read; rescues are best-effort (empty on RPC hiccup).
      const [s, r] = await Promise.all([getStatus(), getRescues().catch(() => [])]);
      setStatus(s);
      setRescues(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  async function disconnect() {
    await closeSession().catch(() => {});
    onDisconnect();
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Liquidation Guardian</h1>
          <p className="tagline">Workflow watches · LLM decides · KeeperHub executes</p>
        </div>
        <div className="header-actions">
          <button className="refresh" onClick={() => void load()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button className="ghost" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error">
          {error} — is the API server running? (<code>npm run dev:api</code>)
        </div>
      )}

      {loading && !status ? (
        <div className="banner">Loading position…</div>
      ) : status ? (
        <>
          <HealthFactorHero status={status} />
          <div className="grid">
            <PositionCard status={status} />
            <RescueOptionsCard status={status} />
          </div>
          <RescueHistory rescues={rescues} />
          <footer className="footer">
            <span>
              {short(status.wallet)} · chain {status.chainId}
            </span>
            <span>updated {new Date(status.updatedAt).toLocaleTimeString()}</span>
          </footer>
        </>
      ) : null}
    </div>
  );
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
