# Liquidation Guardian

> An AI agent that keeps your DeFi borrow positions safe from liquidation, executing the fix
> onchain through [KeeperHub](https://keeperhub.com). Built for the KeeperHub "Last Mile" hackathon.

A KeeperHub workflow watches your Aave health factor around the clock. When a position drifts toward
the liquidation line, an LLM decides the cheapest fix (repay debt or add collateral) and KeeperHub
executes it onchain with simulation, gas backoff, retries, and a full audit trail.

**Workflow watches. LLM decides. KeeperHub executes.**

## Status

Under active development for the hackathon (deadline 2026-08-13). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

> Full walkthrough — including a fresh builder's zero-to-first-tx teardown — in [docs/TEARDOWN.md](docs/TEARDOWN.md).

1. **Get a KeeperHub account.** Sign up at [app.keeperhub.com](https://app.keeperhub.com). A Turnkey
   wallet is auto-provisioned (no private keys to manage). Copy your wallet address.
2. **Create an API key.** Settings → API Keys → Organisation tab. It starts with `kh_`.
3. **Fund on Sepolia.** Get free test ETH from a Sepolia faucet to your wallet address.
4. **Configure.** `cp .env.example .env` and fill in your key, wallet address, and chain.
5. **LLM config (decision layer).** The agent runs on Gemini (OpenAI-compatible) as the primary
   decision model. Add `GEMINI_API_KEY` (from [aistudio.google.com](https://aistudio.google.com),
   starts with `AQ.`). Optional: add `NVIDIA_API_KEY` (from [build.nvidia.com](https://build.nvidia.com))
   as a fallback, keeping `BASE_URL=https://integrate.api.nvidia.com/v1` and optionally
   `LLM_MODEL=deepseek-ai/deepseek-v4-flash`. If `BASE_URL` is exported in your shell, it shadows
   `.env` — unset it first.
6. **Verify with a dry-run first tx** (simulate, no broadcast), then execute for real:
   ```bash
   npm run first-tx
   ```

## Try the Guardian

```bash
npm run setup-position     # open a fresh at-risk LINK/LINK position (HF just above 1.0)
npm run guardian           # the LLM picks the fix; KeeperHub simulates → executes → confirms
```

A full demo script (video + live walkthrough) is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Dashboard (read-only UI)

A web dashboard puts a face on the agent: your live health factor (color-coded by risk), the
collateral/debt breakdown, the sized rescue levers the Guardian is choosing between, and a history
of the rescues it has already executed onchain — each linking to the transaction on Etherscan.

It's split in two so a credential never reaches the browser:

- `server/` — a small API that holds your KeeperHub key **encrypted at rest** (AES-256-GCM, in a
  Redis-backed store) and exposes only read data (`/api/status`, `/api/rescues`). You enter your key,
  wallet, and risk levels once in the onboarding form; the key is kept server-side (HttpOnly cookie
  session), never in the page.
- `web/` — a Vite + React app that renders that data and proxies `/api` to the server in dev.

```bash
# The server needs a master key (encrypts stored keys) and Redis. One-time setup:
#   echo "GUARDIAN_MASTER_KEY=$(openssl rand -hex 32)" >> .env
#   redis-server &            # or point REDIS_URL at a hosted Redis

# terminal 1 — the API (each user enters their own KeeperHub key in the UI)
npm run dev:api

# terminal 2 — the dashboard
cd web && npm install && npm run dev   # then open http://localhost:5173
```

The dashboard is an **observer** — it never signs or broadcasts. Rescues are executed by the
Guardian through KeeperHub; the UI just watches. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Telegram bot + Mini App (phone-native watch + approve)

The same server also runs a Telegram bot when `TELEGRAM_BOT_TOKEN` is set — the "last mile" on a
phone. It **pushes** an alert the instant your health factor drops and lets you approve the fix with
one tap (`[✅ Repay] [🛡 Supply] [✋ Ignore]`); `/auto` switches to autonomous rescue-and-notify.

Onboarding runs through a **Telegram Mini App** (the web form above): your KeeperHub key goes straight
to the server over HTTPS, **never through a chat message**. The server verifies Telegram's signed
`initData` to bind your chat, then encrypts the key at rest. Commands: `/status`, `/auto`, `/stop`,
`/help`.

```bash
# 1. Create a bot with @BotFather, grab the token → TELEGRAM_BOT_TOKEN in .env
# 2. Mini Apps need public HTTPS: tunnel to the app and set WEBAPP_URL to that URL,
#    then register it with @BotFather (/setmenubutton).
# 3. Run the whole stack (server + Telegram bot + Redis) in Docker:
docker compose up --build            # or: npm run docker:dev
```

The bot's long-poll needs no public URL — only the Mini App onboarding does — so `/status`, `/auto`,
alerts, and approvals are demoable behind just a tunnel to the web form.

## Repository layout

```
src/workflows/   KeeperHub workflow definitions (trigger + read + condition)
src/agent/       LLM decision layer (repay vs. add-collateral, + amount)
server/          Hosted API + Telegram bot (encrypted key store, watch loop)
web/             Vite + React dashboard / Telegram Mini App
scripts/         Setup & verification (first-tx dry-run, health checks)
docs/            Architecture, teardown, and pitch material
```

## Why this fits the brief

The hackathon rewards agents that execute onchain reliably, not clever demos that never touch a
chain. Liquidation protection is a use case where reliability is the entire point: a retry that
lands a transaction saves the user real money. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the design maps onto the judging criteria.
