# Liquidation Guardian — Architecture

> An AI agent that keeps your DeFi borrow positions safe from liquidation, executing
> the fix onchain through KeeperHub. Built for the KeeperHub "Last Mile" hackathon.

## The problem (for readers new to DeFi)

When you borrow against crypto collateral on a lending protocol like **Aave**, the protocol
tracks a **health factor** — a number where `1.0` is the liquidation line. If your collateral
drops in value (or your debt's value rises), the health factor falls toward `1.0`. Cross it and
you get **liquidated**: the protocol force-sells your collateral at a penalty. People lose real
money this way, often while asleep.

The fix is mechanical but must happen *fast and reliably*: either **repay some debt** or **add
collateral** to push the health factor back up. That "must happen reliably, onchain, right now"
is exactly KeeperHub's last-mile problem — which is why this project fits the brief's thesis.

## Design principle: workflow watches, LLM decides

```
                        ┌─────────────────────────────────────────────┐
   always-on, cheap,    │  KeeperHub Workflow  (deterministic)         │
   never sleeps,        │                                              │
   retries built in     │   [Block/Schedule Trigger]                   │
                        │            │                                 │
                        │            ▼                                 │
                        │   [Action: read Aave health factor]  ◄─ aave-v3/get-user-account-data
                        │            │                                 │
                        │            ▼                                 │
                        │   [Condition: HF < THRESHOLD ?]              │
                        │        │ false → end (cheap, no-op)          │
                        │        │ true                                │
                        └────────┼─────────────────────────────────────┘
                                 ▼  handoff (HTTP webhook on Pro,
                                 ▼   out-of-band trigger on free)
   engages only when     ┌─────────────────────────────────────────────┐
   there's a real        │  LLM Decision Layer  (Gemini / NVIDIA NIM)   │
   decision to make      │                                              │
                        │  Inputs: HF, collateral, debt, wallet        │
                        │  balances + Aave Pool allowance              │
                        │  Decides: repay vs add-collateral, + amount   │
                        │  to restore HF to TARGET                     │
                        └────────┬─────────────────────────────────────┘
                                 ▼
                        ┌─────────────────────────────────────────────┐
   the "last mile" —     │  KeeperHub Execution                         │
   KeeperHub owns this   │                                              │
                        │  1. simulate:true  → gas estimate + revert   │
                        │     check, no broadcast                      │
                        │  2. if clean → execute_protocol_action       │
                        │     (aave-v3/repay OR aave-v3/supply)        │
                        │  3. gas backoff + retries on failure         │
                        │  4. audit trail: trigger→sim→tx→gas→outcome  │
                        │  5. notify (Discord/Telegram)                │
                        └─────────────────────────────────────────────┘
```

**How this split maps onto the judging criteria:**

| Criterion | How this design hits it |
|---|---|
| Executes onchain via KeeperHub | `execute_protocol_action` (aave-v3) is a real tx; every rebalance is linkable |
| Use of KeeperHub surfaces | Workflow builder, conditions, protocol plugins, simulate, audit trail, notifications |
| Reliability & observability | Deterministic monitor + simulate-first + gas backoff + retries + audit trail = the core loop |
| Originality & usefulness | "Don't get liquidated while you sleep" is a use case people actually run |
| Integration quality | Clean separation: KeeperHub owns execution, LLM owns judgment, thin glue |

## Components

- **`src/workflows/`** — the KeeperHub monitor definition, built in code
  ([liquidation-monitor.ts](../src/workflows/liquidation-monitor.ts)) as the reproducible source of
  truth, with the pushed graph checked in as `liquidation-monitor.json`. Deployed by
  [scripts/deploy-workflow.ts](../scripts/deploy-workflow.ts) (`npm run deploy-workflow`).
- **`src/agent/`** — the LLM decision layer. Receives position snapshot, returns a structured
  decision `{ action: "repay"|"supply", token, amount, reasoning }`, then calls KeeperHub to execute.
  Lever executability is checked before the LLM: repay/supply are only offered when the wallet
  balance and Aave Pool allowance cover the sized amount — simulate-first is the final safety net,
  not the first one.
- **`scripts/`** — setup & verification: first-tx dry-run, health checks, sizing tests, workflow deploy.
- **`server/` + `web/`** — the hosted face: an observer dashboard **and** a Telegram bot, in one
  node process (port 8787). `server/` holds each user's KeeperHub key **encrypted at rest**
  (AES-256-GCM) in a Redis-backed store (`server/store.ts`), keyed by an HttpOnly cookie for the web
  session and by verified Telegram user id for the bot. `web/` (Vite + React) is a pure viewer that
  proxies `/api` to it and doubles as the Telegram Mini App. The browser/chat never sees the key and
  never connects or signs a wallet. Execution stays entirely on the KeeperHub side, exactly as the CLI
  path.

## Telegram bot + Mini App (the phone-native face)

Real DeFi users live on their phones, and a liquidation guardian's value is in *pushing* the instant
health factor drops. The bot (`server/bot.ts`) closes that last mile:

```
Telegram ──Mini App (web form + initData)──▶ POST /api/session ──▶ verify initData
   ▲                                                              ├▶ validate key w/ KeeperHub
   │  alert · inline [✅ Repay][🛡 Supply][✋ Ignore] · callbacks   ├▶ encrypt + persist record
   │                                                              └▶ bind telegramUserId, notify chat
   └──────────  bot loop + watch loop  ◀── shared encrypted store ──▶ runGuardianOnce / executeRescue
```

- **Onboarding never touches chat.** The bot opens a **Mini App** rendering the existing web form; the
  KeeperHub key POSTs straight to the backend over HTTPS. The Mini App forwards Telegram's signed
  `initData`, which the server verifies (`server/verifyInitData.ts`: HMAC-SHA256 with
  `secret = HMAC("WebAppData", botToken)`, plus a 24h `auth_date` freshness check) to authenticate the
  user and bind their chat — so knowing someone's public wallet grants nothing.
- **Watch + approve.** A watch loop re-reads every stored position every `WATCH_INTERVAL_MS`. Below
  threshold it sizes the levers (`buildSnapshot` + `computeCandidates`, same as the dashboard) and
  sends one-tap buttons; nothing broadcasts until the user taps, which runs
  `executeRescue(candidateToDecision(chosen))`. `/auto` flips to autonomous `runGuardianOnce` +
  notify. `/status`, `/stop`, `/help` round it out.
- **Same engine, two seams.** The only new exports in the core are `candidateToDecision` (execute a
  user-chosen lever without re-running the LLM) and `executeRescue` (steps 5–9 of `runGuardianOnce`,
  factored out). Everything else is reused unchanged.
- **One process, one container.** Bot and HTTP API share the store directly, so the server can notify
  a chat the instant it stores a key. A multi-stage `Dockerfile` + `docker-compose.yml` (guardian +
  redis) run the whole thing with `docker compose up`.
- **Both primitives are unit-gated.** [scripts/test-security.ts](../scripts/test-security.ts)
  (`npm run test-security`) signs an `initData` payload the way Telegram does and asserts every tamper
  is rejected (flipped hash, swapped user, wrong bot token, stale `auth_date`, missing user), then
  asserts the credential round-trips through AES-256-GCM, that a wrong master key / tampered ciphertext
  fail the auth tag, and that the serialized blob holds no plaintext `kh_`. Exits non-zero on any miss.


## The deployed monitor (the "watches" half)

Live on the account as **"Liquidation Guardian — Monitor"** (Sepolia, id `7s6n67keu1a60ra34jdzm`),
created **disabled** so no schedule fires until it's turned on. It's the deterministic watcher, three
nodes:

```
[Schedule */10 * * * * UTC] → [aave-v3/get-user-account-data] → [Condition: healthFactor < 1.15e18]
```

Two deploy-time realities shaped it (TEARDOWN F11):

- **No REST create.** `POST /api/workflows` returns 405 — creation is MCP/UI only. So the deploy
  script pushes the graph by **PATCH-in-place**, overwriting an existing workflow object (the approved
  stub) and reusing its id. `GET`/`PATCH`/`DELETE` on `/workflows/:id` all work.
- **The webhook handoff is a Pro node.** The true branch's ideal next step is an HTTP POST of the
  position snapshot to the Guardian, but `action.http-request` is gated behind KeeperHub Pro (a live
  402 confirmed it). On the free plan the graph ends at the Condition and the Guardian is triggered
  **out-of-band**; the builder's `includeHandoff` flag (and `deploy-workflow --with-http`) adds the
  in-workflow webhook once on Pro. Either way, KeeperHub still owns the watch, the branch, and the
  execution — only the workflow→Guardian hop moves outside on the free tier.

## Execution safety: simulate before broadcast

Every write goes through KeeperHub's `simulate: true` preflight first. Only if the result is
`success: true` and `wouldRevert: false` do we re-issue the call for real, with a unique
`idempotency_key`, then poll `get_direct_execution_status`.

## Multi-asset sizing (how much to repay / supply)

The decision layer picks *which* lever to pull; the **amount** is computed deterministically in
[src/agent/decide.ts](../src/agent/decide.ts), in fixed-point, and is never a model-produced number.
Aave's health factor is `HF = N / D`, with weighted collateral `N = Σ collateral·price·LT` and debt
`D = Σ debt·price`. To restore HF to a `target`:

```
repay debt asset k:      R_k = D·(1 − HF/target) / price_k        (capped at that asset's debt)
supply collateral m:     S_m = D·(target − HF) / (price_m · LT_m)
```

The sizing is **tiered by how many assets a side holds**, so it reads an oracle only when it has to:

| Side acted on | Formula used | Price feed? | Per-asset LT? |
|---|---|---|---|
| **1 debt asset** (repay) | `R = debtTokens·(1 − HF/target)` | no — price cancels | no |
| **1 collateral asset** (supply) | `S = collTokens·(target/HF − 1)` | no — price *and* LT cancel | no |
| **≥2 debt assets** (repay) | `R_k = D·(1 − HF/target)/price_k` | yes, for the repaid asset | no |
| **≥2 collateral assets** (supply) | `S_m = D·(target − HF)/(price_m·LT_m)` | yes, for the supplied asset | yes, for the supplied asset |

The single-asset rows are **exact for any pair of tokens** — collateral and debt need not be the same
asset for the price to cancel; each lever scales one whole side proportionally, so the common factor
divides out. That's why the Sepolia demo (LINK collateral + LINK debt) makes **zero** oracle calls and
the rescue amount is pure token arithmetic. Prices are consulted only when the acted-on side is a
genuine basket (e.g. WETH+WBTC collateral, or USDC+DAI debt).

- **Prices** come from Chainlink via [src/agent/prices.ts](../src/agent/prices.ts), using the generic
  `chainlink/latest-answer` action with an explicit feed address (KeeperHub's *named* feeds aren't all
  deployed on Sepolia — see TEARDOWN F10). An asset with no feed returns `null` and the agent won't act
  on that side — it never guesses a price.
- **Per-asset liquidation thresholds** (for the multi-collateral supply lever only) come from Aave's
  live Sepolia reserve config, read once and cached in [src/agent/assets.ts](../src/agent/assets.ts).
- **Composition discovery**: [src/agent/guardian.ts](../src/agent/guardian.ts) `buildSnapshot()` scans
  the known reserves for the user's actual debt/collateral balances, then fetches prices only for a side
  with ≥2 assets.

The whole tier ladder is unit-verified in [scripts/test-sizing.ts](../scripts/test-sizing.ts)
(`npm run test-sizing`) with worked examples that each land exactly on the target HF, plus a live
KeeperHub dry-run. The **live demo stays LINK/LINK** because Sepolia only lets a single wallet
open a single-asset position (TEARDOWN F5); the multi-asset path is proven by the unit suite.

## Demo plan (Sepolia, confirmed live)

Sepolia Aave v3 IS live through KeeperHub (also chain 1, 8453, 42161 — not Base Sepolia, Arb
Sepolia, Op Sepolia, Polygon). The live demo is a **LINK collateral + LINK debt** position because
that's what this Sepolia deployment allows (stables are supply-capped / have no borrow liquidity —
TEARDOWN F5). A single-asset position is the *cleanest* demo, not a compromise: the price cancels
out of the health factor, so the rescue amount is exact token arithmetic with no oracle.

The demo loop (see [docs/DEMO_SCRIPT.md](DEMO_SCRIPT.md)):
`npm run setup-position` opens a fresh at-risk position (borrows up to ~97% of capacity, HF just
above 1.0) → `npm run guardian` reads it, the decision layer (Gemini primary, NVIDIA NIM fallback)
picks repay vs. supply, KeeperHub simulates first, then broadcasts and confirms. The real rescue tx
is independently verifiable via RPC `eth_getLogs` on the Aave Pool's `Repay` event (TEARDOWN F9).

## Resolved earlier open questions

- **Is `aave-v3` on Sepolia?** Yes — confirmed live (this build's real rescue ran there).
- **Gas sponsorship on testnets?** Yes — Sepolia transfers were fully gas-sponsored (balance
  untouched to the wei), despite the brief saying "mainnet only" (TEARDOWN F4).
- **Are Stripe / x402scan surfaces live?** Not in the current docs; nothing in this build depends on
  them (TEARDOWN F1).
