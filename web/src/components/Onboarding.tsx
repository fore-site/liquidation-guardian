import { useEffect, useState } from "react";
import { openSession, resumeSession, type Credentials, type SessionConfig } from "../api.js";
import { initTelegram, isInTelegram, telegramInitData } from "../telegram.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Slider } from "./ui/slider.js";
import { cn } from "../lib/utils.js";

/**
 * First-run screen. Collects the user's own KeeperHub key + wallet + risk levels,
 * then hands the key to the server ONCE (it's held server-side, never stored in the
 * browser). No terminal, no .env, no code.
 *
 * Returning users (who already onboarded — the record persists server-side) can
 * **resume** with just their wallet address: the server re-issues the session
 * cookie without asking for the key again.
 *
 * When opened inside Telegram (the bot's Mini App), it also forwards the signed
 * `initData` so the server can bind the credential to the verified Telegram user.
 */
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

  useEffect(() => {
    initTelegram();
  }, []);

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

  function go(config: SessionConfig) {
    if (onConnected) onConnected(config);
    else window.location.href = "/dashboard";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setConnectError(null);
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
      if (config) go(config);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  }

  /** Resume an existing stored session — wallet only, no key re-entry. */
  async function resume(e: React.FormEvent) {
    e.preventDefault();
    setResumeBusy(true);
    setResumeError(null);
    try {
      const { config } = await resumeSession({
        wallet: resumeWallet.trim(),
        chainId: "11155111",
        ...(inTelegram ? { initData: telegramInitData() } : {}),
      });
      if (config) go(config);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : "Couldn't find that wallet — connect it first.");
    } finally {
      setResumeBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4 text-foreground">
      <a href="/" className="mb-6 text-sm text-muted-foreground hover:text-foreground">
        ← Back to home
      </a>

      <div className="w-full max-w-md">
        <h1 className="text-balance text-center text-3xl font-semibold tracking-tight">
          Connect your position
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-center text-sm text-muted-foreground">
          Your KeeperHub key goes straight to the server over HTTPS. It never touches this browser again.
        </p>

        {/* Mode switch */}
        <div className="mx-auto mt-6 grid grid-cols-2 gap-2 rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
          {([
            "connect",
            "resume",
          ] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-[calc(2rem-0.375rem)] bg-card border border-border py-1.5 text-sm font-medium transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                mode === m ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "connect" ? "New position" : "Resume monitoring"}
            </button>
          ))}
        </div>

        <div className="mt-6 rounded-[2rem] p-1.5 bg-black/10 border border-white/5">
          <div className="rounded-[calc(2rem-0.375rem)] bg-card border border-border p-6">
            {mode === "resume" ? (
              <form onSubmit={resume} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="resume-wallet">Wallet address</Label>
                  <Input
                    id="resume-wallet"
                    type="text"
                    placeholder="0x…"
                    value={resumeWallet}
                    onChange={(e) => setResumeWallet(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    We look up the position you already connected and restore the dashboard. No key needed.
                  </p>
                </div>
                {resumeError && (
                  <div role="alert" className="rounded-[calc(2rem-0.375rem)] p-3 bg-risk/10 text-sm text-risk">
                    {resumeError}
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={resumeBusy}>
                  {resumeBusy ? "Checking…" : "Resume monitoring"}
                </Button>
              </form>
            ) : (
              <form onSubmit={submit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="kh">KeeperHub API key</Label>
                  <Input
                    id="kh"
                    type="password"
                    placeholder="kh_…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wallet">Wallet address</Label>
                  <Input
                    id="wallet"
                    type="text"
                    placeholder="0x…"
                    value={wallet}
                    onChange={(e) => setWallet(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>

                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Defense profile</Label>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <ProfileCard
                      title="The Conservative"
                      body="Act early, restore high"
                      active={profile === "conservative"}
                      onClick={() => pickProfile("conservative")}
                    />
                    <ProfileCard
                      title="Capital Efficient"
                      body="Ride the edge for yield"
                      active={profile === "efficient"}
                      onClick={() => pickProfile("efficient")}
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>
                      Act below <span className="font-mono font-semibold text-accent">{threshold.toFixed(2)}</span>
                    </Label>
                  </div>
                  <div className="space-y-2">
                    <Slider
                      aria-label="Act below health factor"
                      min={1.05}
                      max={2.5}
                      step={0.05}
                      value={[threshold]}
                      onValueChange={([t]) => {
                        setThreshold(t);
                        if (target < t + 0.1) setTarget(Math.round((t + 0.5) * 100) / 100);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>
                      Restore to <span className="font-mono font-semibold text-accent">{Math.max(target, targetFloor).toFixed(2)}</span>
                    </Label>
                  </div>
                  <div className="space-y-2">
                    <Slider
                      aria-label="Restore health factor to"
                      min={targetFloor}
                      max={3}
                      step={0.05}
                      value={[Math.max(target, targetFloor)]}
                      onValueChange={([t]) => setTarget(t)}
                    />
                  </div>
                </div>

                {connectError && (
                  <div role="alert" className="rounded-[calc(2rem-0.375rem)] p-3 bg-risk/10 text-sm text-risk">
                    {connectError}
                  </div>
                )}

                <Button type="submit" disabled={busy} className="w-full" size="lg">
                  {busy ? "Connecting…" : "Connect & watch"}
                </Button>

                <p className="text-center text-xs text-muted-foreground">
                  Rescues are executed by KeeperHub under the delegation you signed. This page never asks you to connect or sign a wallet.
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileCard({
  title,
  body,
  active,
  onClick,
}: {
  title: string;
  body: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-[calc(2rem-0.375rem)] border p-3 text-left transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-secondary/40 hover:border-input hover:bg-secondary",
      )}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
    </button>
  );
}