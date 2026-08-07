# Liquidation Guardian

> An AI agent that keeps your DeFi borrow positions safe from liquidation, executing the fix
> onchain through [KeeperHub](https://keeperhub.com).

An event-driven watcher tracks your Aave health factor around the clock, reacting to the pool
events that actually move it — supply, repay, borrow, withdraw, liquidation, and oracle price
updates. When a position drifts toward the liquidation line, an LLM decides the cheapest fix
(repay debt or add collateral) and KeeperHub executes it onchain with simulation, gas backoff,
retries, and a full audit trail.

**Event watcher watches. LLM decides. KeeperHub executes.**

Three things make it different: **dynamic risk awareness** (the LLM weighs the cost
of each fix, including gas, instead of following rigid rules), **one-click defense
profiles** (Conservative or Capital Efficient, in plain English), and **non-custodial
trust** (the agent only carries limited execution permission — it can never withdraw
to an external wallet). A landing page with an avoided-loss ROI calculator is in
`web/`.

## Status

Actively maintained. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

> Full walkthrough — including a fresh builder's zero-to-first-tx teardown — in [docs/TEARDOWN.md](docs/TEARDOWN.md).

1. **Get a KeeperHub account.** Sign up at [app.keeperhub.com](https://app.keeperhub.com). A Turnkey
   wallet is auto-provisioned (no private keys to manage). Copy your wallet address.
2. **Create an API key.** Settings → API Keys → Organisation tab. It starts with `kh_`.
3. **Fund on Sepolia.** Get free test ETH from a Sepolia faucet to your wallet address.
4. **Configure.** `cp .env.example .env` and fill in your key, wallet address, and chain.
5. **LLM config (decision layer).** The agent works with any OpenAI-compatible provider. Set
   `LLM_API_KEY`, `LLM_BASE_URL` (the provider's `/v1` endpoint), and `LLM_MODEL` in `.env`. For
   example, OpenRouter: key from [openrouter.ai](https://openrouter.ai), base URL
   `https://openrouter.ai/api/v1`, model `deepseek/deepseek-v4-flash-0731`.
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

- `server/` — the shared engine: encrypted key store (AES-256-GCM, Redis-backed),
  the watch loop, and the Telegram bot. You enter your key, wallet, and risk
  levels once in the onboarding form; the key is kept server-side (HttpOnly
  cookie session), never in the page.
- `web/` — a TanStack Start (React + Vite + nitro) app that renders that data;
  the API runs as in-process server functions, so no separate proxy is needed
  in dev or production.

```bash
# The server needs a master key (encrypts stored keys) and Redis. One-time setup:
#   echo "GUARDIAN_MASTER_KEY=$(openssl rand -hex 32)" >> .env
#   redis-server &            # or point REDIS_URL at a hosted Redis

# the dashboard + API + bot, in one process (each user enters their own KeeperHub key in the UI)
npm run dev:api

# or run the web app standalone in dev (Vite on :3000)
cd web && npm install && npm run dev
```

The dashboard is an **observer** — it never signs or broadcasts. Rescues are executed by the
Guardian through KeeperHub; the UI just watches. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Telegram bot + Mini App (phone-native watch + approve)

The same server also runs a Telegram bot when `TELEGRAM_BOT_TOKEN` is set — alerts on your
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
src/agent/       LLM decision layer (repay vs. add-collateral, + amount)
server/          Hosted API + Telegram bot + event-driven watcher (encrypted key store, watch loop)
web/             TanStack Start (React + Vite + nitro) dashboard / Telegram Mini App
scripts/         Setup & verification (first-tx dry-run, health checks)
docs/            Architecture, teardown, and pitch material
```

## Why reliability is the point

Liquidation protection is a use case where reliability is the entire product: a retry that
lands a transaction saves the user real money. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the design is built around that.
