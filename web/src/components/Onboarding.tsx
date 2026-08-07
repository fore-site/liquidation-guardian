import { useEffect, useState } from "react";
import { openSession, type Credentials, type SessionConfig } from "../api.js";
import { initTelegram, isInTelegram, telegramInitData } from "../telegram.js";

/**
 * First-run screen. Collects the user's own KeeperHub key + wallet + risk levels,
 * then hands the key to the server ONCE (it's held server-side, never stored in the
 * browser). No terminal, no .env, no code — this replaces the whole CLI setup.
 *
 * When opened inside Telegram (the bot's Mini App), it also forwards the signed
 * `initData` so the server can bind the credential to the verified Telegram user and
 * push alerts to that chat — the key still goes straight over HTTPS, never through chat.
 */
export function Onboarding({ onConnected }: { onConnected?: (config: SessionConfig) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [wallet, setWallet] = useState("");
  const [profile, setProfile] = useState<"conservative" | "efficient" | null>(null);
  const [threshold, setThreshold] = useState(1.5);
  const [target, setTarget] = useState(2.0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inTelegram = isInTelegram();

  // Tell Telegram we're ready + expand to full height (no-op in a normal browser).
  useEffect(() => {
    initTelegram();
  }, []);

  // Defense profiles preset the threshold/target sliders (frontend-only presets —
  // the backend just receives the numbers).
  function pickProfile(p: "conservative" | "efficient") {
    setProfile(p);
    if (p === "conservative") {
      setThreshold(1.6);
      setTarget(2.0);
    } else {
      setThreshold(1.1);
      setTarget(1.5);
    }
  }

  const targetFloor = Math.round((threshold + 0.1) * 100) / 100;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const creds: Credentials = {
        keeperHubApiKey: apiKey.trim(),
        wallet: wallet.trim(),
        chainId: "11155111",
        hfThreshold: threshold,
        hfTarget: Math.max(target, targetFloor),
        ...(inTelegram ? { initData: telegramInitData() } : {}),
      };
      const { config } = await openSession(creds);
      if (config) {
        // Standalone page (/start): jump to the dashboard route. Inline
        // (the Mini App flow in /app): switch to the dashboard.
        if (onConnected) onConnected(config);
        else window.location.href = "/app";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <a className="onboarding-back" href="/">
          ← Back to home
        </a>
        <h1>Liquidation Guardian</h1>

        <form onSubmit={submit}>
          <label>
            <span>KeeperHub API key</span>
            <input
              type="password"
              placeholder="kh_…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              required
            />
            <small>Held on the server, never stored in your browser.</small>
          </label>

          <label>
            <span>Wallet address</span>
            <input
              type="text"
              placeholder="0x…"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <small>Wallet holding the Aave position to protect (Sepolia).</small>
          </label>

          <div className="profiles">
            <span className="profiles-label">Defense profile</span>
            <div className="profile-options">
              <button
                type="button"
                className={`profile ${profile === "conservative" ? "selected" : ""}`}
                onClick={() => pickProfile("conservative")}
              >
                <strong>The Conservative</strong>
                <small>Act early — prioritize absolute safety.</small>
              </button>
              <button
                type="button"
                className={`profile ${profile === "efficient" ? "selected" : ""}`}
                onClick={() => pickProfile("efficient")}
              >
                <strong>The Capital Efficient</strong>
                <small>Ride the edge — maximize yield.</small>
              </button>
            </div>
            <small>Presets the thresholds below; fine-tune anytime.</small>
          </div>

          <div className="sliders">
            <label>
              <span>
                Act below <strong>{threshold.toFixed(2)}</strong>
              </span>
              <input
                type="range"
                min={1.05}
                max={2.5}
                step={0.05}
                value={threshold}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  setThreshold(t);
                  if (target < t + 0.1) setTarget(Math.round((t + 0.5) * 100) / 100);
                }}
              />
              <small>Below this, the Guardian steps in.</small>
            </label>

            <label>
              <span>
                Restore to <strong>{Math.max(target, targetFloor).toFixed(2)}</strong>
              </span>
              <input
                type="range"
                min={targetFloor}
                max={3}
                step={0.05}
                value={Math.max(target, targetFloor)}
                onChange={(e) => setTarget(Number(e.target.value))}
              />
              <small>Rescues the position back up to this.</small>
            </label>
          </div>

          {error && <div className="banner error">{error}</div>}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect & watch"}
          </button>
        </form>

        <p className="footnote">
          Read-only dashboard. Rescues are executed by KeeperHub under the delegation you signed —
          this page never asks you to connect or sign a wallet.
        </p>
      </div>
    </div>
  );
}
