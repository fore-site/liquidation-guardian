import { useEffect, useState } from "react";
import { openSession, type Credentials, type SessionConfig } from "../api.js";
import { initTelegram, isInTelegram, telegramInitData } from "../telegram.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Slider } from "./ui/slider.js";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.js";

/**
 * First-run screen. Collects the user's own KeeperHub key + wallet + risk levels,
 * then hands the key to the server ONCE (it's held server-side, never stored in the
 * browser). No terminal, no .env, no code.
 *
 * When opened inside Telegram (the bot's Mini App), it also forwards the signed
 * `initData` so the server can bind the credential to the verified Telegram user.
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
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md bg-card">
        <CardHeader>
          <a href="/" className="mb-1 text-sm text-muted-foreground hover:text-foreground">
            ← Back to home
          </a>
          <CardTitle className="text-2xl">Connect your position</CardTitle>
          <CardDescription>
            Your KeeperHub key goes straight to the server over HTTPS — never stored in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
              <Label>Defense profile</Label>
              <Tabs
                value={profile ?? undefined}
                onValueChange={(v) => pickProfile(v as "conservative" | "efficient")}
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="conservative">The Conservative</TabsTrigger>
                  <TabsTrigger value="efficient">Capital Efficient</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>
                  Act below <span className="font-bold text-primary">{threshold.toFixed(2)}</span>
                </Label>
                <Slider
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
                  Restore to{" "}
                  <span className="font-bold text-primary">{Math.max(target, targetFloor).toFixed(2)}</span>
                </Label>
                <Slider
                  min={targetFloor}
                  max={3}
                  step={0.05}
                  value={[Math.max(target, targetFloor)]}
                  onValueChange={([t]) => setTarget(t)}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-risk/40 bg-risk/10 p-3 text-sm text-risk">
                {error}
              </div>
            )}

            <Button type="submit" disabled={busy} className="w-full" size="lg">
              {busy ? "Connecting…" : "Connect & watch"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Rescues are executed by KeeperHub under the delegation you signed — this page never
              asks you to connect or sign a wallet.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
