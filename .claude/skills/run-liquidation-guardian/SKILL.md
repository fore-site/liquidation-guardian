---
name: run-liquidation-guardian
description: Build, launch, and drive the Liquidation Guardian web app (TanStack Start + nitro). Use when asked to run, start, serve, screenshot, or smoke-test the Guardian dashboard/onboarding UI, or to reach the live Aave position through the app end-to-end.
---

# Run: Liquidation Guardian

A TanStack Start (nitro) web app that watches an Aave position and lets an LLM
agent execute rescues via KeeperHub. The API is folded into the web app as
server functions ([web/src/server/](web/src/server/)) — there is no separate
backend to start. State lives in **Redis**; onboarding does a **live KeeperHub
round-trip** to read the on-chain position.

The app has no headless-drivable API of its own, so the agent path is a
zero-dependency Chrome DevTools Protocol driver
([.claude/skills/run-liquidation-guardian/driver.mjs](.claude/skills/run-liquidation-guardian/driver.mjs)):
it launches system `google-chrome --headless`, drives onboarding → dashboard,
and writes screenshots. It uses Node 22's built-in `WebSocket` as the CDP
transport — nothing to `npm install`.

**All paths below are relative to the repo root** (`/home/foresite/Documents/keeperhub`).

## Prerequisites

Present in this container (no `apt-get` was needed):
- Node ≥ 22 (built-in `WebSocket`, used by the driver) — was `v22.x`.
- `redis-server` + `redis-cli`.
- `google-chrome` at `/usr/bin/google-chrome`.

If any are missing on a fresh box: `sudo apt-get install -y redis-server google-chrome-stable`.

Deps were already installed here; a clean checkout needs (not re-run this session):
`npm install && npm install --prefix web`.

Secrets live in the repo-root [.env](.env) (real KeeperHub key, LLM key, Telegram
token). The launch + driver read them from the environment — never hardcode them.
Required for the full flow: `GUARDIAN_MASTER_KEY`, `REDIS_URL`,
`KEEPERHUB_API_KEY`, `WALLET_ADDRESS`.

## Run (agent path) — FIRST

Two steps: launch the stack, then drive it.

1. Launch (Redis + dev server, backgrounded). `serve.sh` sources the root `.env`,
   blanks `TELEGRAM_BOT_TOKEN` so the bot/watcher stay off for a clean local run,
   and execs the dev server on **:3000**:

```bash
.claude/skills/run-liquidation-guardian/serve.sh
```

Wait for it to serve, then confirm:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

2. Drive it. Source the root `.env` so the driver gets live creds, then run:

```bash
set -a; . ./.env; set +a
node .claude/skills/run-liquidation-guardian/driver.mjs
```

Screenshots land in `.claude/skills/run-liquidation-guardian/shots/`:
`01-landing.png`, `02-onboard.png`, `03-onboard-filled.png`, `04-dashboard.png`.
**Open `04-dashboard.png` and look** — a real run shows a numeric health factor,
USD collateral/debt, sized rescue options, the HF chart, and rescue history with
Sepolia tx hashes. Blank card or `04-onboard-state.png` = the flow didn't reach
the dashboard (see Troubleshooting).

UI-only (no creds, no KeeperHub round-trip — just landing + onboarding):

```bash
node .claude/skills/run-liquidation-guardian/driver.mjs --no-dashboard
```

Flags: `--base=<url>` (default `http://localhost:3000`), `--no-dashboard`.

## Direct invocation (internal logic, no browser)

The agent/KeeperHub logic is exercised by [scripts/](scripts/) (wired in
[package.json](package.json)). Read-only, verified this session — reads the live
Aave position through KeeperHub and prints HF + rescue sizing:

```bash
set -a; . ./.env; set +a
npm run read-position
```

Other scripts in `package.json` (`guardian`, `test-sizing`, `first-tx`) send
**real transactions** — run only against a test wallet you own.

## Run (human path)

`cd web && npm run dev` opens the Vite dev server on :3000; browse to
`http://localhost:3000`. But it must be started with the root `.env` loaded into
its environment (see Gotchas #1), and it spawns no window — useless headless.
Prefer `serve.sh`.

## Test / typecheck

Root typecheck passes clean (verified): `npm run typecheck` → tsc `--noEmit`,
exit 0. There is no unit-test suite; the `test-*` npm scripts are live
on-chain/LLM harnesses, not offline tests.

## Gotchas (things that cost time here)

1. **dotenv resolves `.env` from the CWD, not the repo root.** The dev server
   runs from `web/`, so `dotenv/config` never finds the root `.env` and the
   server functions boot without `GUARDIAN_MASTER_KEY` / `REDIS_URL`. Fix: start
   with the root env sourced into the process — `serve.sh` does this for you.
2. **Server functions reject direct `curl`.** TanStack Start's RPC endpoint
   requires browser origin/CSRF headers; hand-rolled `curl` gets `Forbidden`.
   You must drive through a real browser — that's why the driver exists.
3. **The bot/watcher auto-start** whenever `TELEGRAM_BOT_TOKEN` is set to a real
   value (long-polls Telegram, opens the event watcher). `serve.sh` blanks it so
   the local run is fully self-contained. To exercise the bot, set it yourself.
4. **CDP flatten mode is single-connection.** After `Target.attachToTarget
   {flatten:true}`, send every page command over the **same** WebSocket with a
   top-level `sessionId`. Opening a second socket for the session gives
   `'Page.enable' wasn't found`.
5. **Use `Emulation.setDeviceMetricsOverride`**, not `Page.setDeviceMetrics…`
   (removed). Without a metrics override, `Page.captureScreenshot` fails with
   `Cannot take screenshot with 0 width` in headless.
6. **React controlled inputs ignore `el.value = …`.** The driver sets values via
   the native prototype setter then dispatches a bubbling `input` event; a plain
   assignment leaves React's state stale and the submit sends empty fields.
7. **The session cookie persists in the Chrome profile.** After one successful
   onboard, `/onboard` redirects straight to `/dashboard` and `#kh` is gone. The
   driver wipes its profile dir each run so every run starts clean and
   deterministic.
8. **Onboarding is a live KeeperHub call.** It reads the real Aave position over
   the network; without `KEEPERHUB_API_KEY` + `WALLET_ADDRESS` (and connectivity
   to KeeperHub) the driver still captures landing + onboarding but skips the
   dashboard. Onboarding is idempotent (keyed by wallet), so re-runs are safe.
9. **No `playwright` / `chromium-cli` package and no npm network here** — that's
   the reason the driver rolls its own CDP client on the built-in `WebSocket`
   against system `google-chrome`. Don't "fix" it by adding a browser dep.
10. **A stray listener on :8787** is a pre-existing unrelated process, not part
    of this app. Ignore it; the app is entirely on :3000.

## Troubleshooting

- **`curl` to `/` never returns 200 / connection refused** — the dev server is
  still building (first boot compiles the app; give it ~15–30s) or Redis isn't
  up. Check `redis-cli ping` → `PONG`; re-run `serve.sh`.
- **Driver: `Chrome CDP endpoint never came up`** — a stale chrome may hold port
  9333. `pkill -f 'remote-debugging-port=9333'` then re-run. (Don't put `pkill`
  in the same shell line as the node command — it can match and kill the tool's
  own shell, surfacing as exit 144.)
- **`04-onboard-state.png` instead of `04-dashboard.png`** — the KeeperHub read
  failed. Confirm `KEEPERHUB_API_KEY` + `WALLET_ADDRESS` are exported (`set -a;
  . ./.env; set +a`) and that the position exists on the configured chain; the
  driver logs `onboarding error: …` with the on-screen message.
- **Dashboard loads but health factor is blank / "Loading position…"** — the
  server-fn couldn't reach KeeperHub or Redis. Verify `serve.sh` was launched
  with the root `.env` present (Gotcha #1) and `REDIS_URL` points at the running
  Redis.

