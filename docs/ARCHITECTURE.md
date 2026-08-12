# Liquidation Guardian — Architecture

> An AI agent that keeps your DeFi borrow positions safe from liquidation, executing
> the fix onchain through KeeperHub.

## The problem (for readers new to DeFi)

When you borrow against crypto collateral on a lending protocol like **Aave**, the protocol
tracks a **health factor** — a number where `1.0` is the liquidation line. If your collateral
drops in value (or your debt's value rises), the health factor falls toward `1.0`. Cross it and
you get **liquidated**: the protocol force-sells your collateral at a penalty. People lose real
money this way, often while asleep.

The fix is mechanical but must happen *fast and reliably*: either **repay some debt** or **add
collateral** to push the health factor back up. That "must happen reliably, onchain, right now"
is exactly KeeperHub's last-mile problem — which is why this project is built the way it is.

## Design principle: event watcher watches, LLM decides

```
                        ┌─────────────────────────────────────────────┐
   always-on, cheap,    │  Event-Driven Watcher  (deterministic)      │
   never sleeps,        │  server/event-watcher.ts                    │
   reacts to the chain  │                                              │
                        │  [Poll Aave Pool logs — Supply/Repay/Borrow/ │
                        │   Withdraw/Liquidation/ReserveDataUpdated]  │
                        │            │                                 │
                        │            ▼                                 │
                        │   [Re-read affected positions' health factor]│
                        │   (via KeeperHub aave-v3/get-user-account-data)
                        │            │                                 │
                        │            ▼                                 │
                        │   [HF < THRESHOLD ?]  ── false → no-op       │
                        │            │ true                            │
                        └────────────┼────────────────────────────────┘
                                     ▼  handoff (same process → bot.runCheck)
   engages only when     ┌─────────────────────────────────────────────┐
   there's a real        │  LLM Decision Layer  (OpenAI-compatible)     │
   decision to make      │                                              │
                         │  Inputs: HF, collateral, debt, wallet        │
                         │  balances + Aave Pool allowance, gas cost     │
                         │  per lever (when the RPC provides a price)    │
                         │  Decides: repay vs add-collateral, + amount   │
                         │  to restore HF to TARGET at lowest cost       │
                         └────────┬─────────────────────────────────────┘
                                  ▼
                         ┌─────────────────────────────────────────────┐
   the execution layer — │  KeeperHub Execution                         │
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

**How this split maps onto the design goals:**

| Goal | How this design hits it |
|---|---|
| Executes onchain via KeeperHub | `execute_protocol_action` (aave-v3) is a real tx; every rebalance is linkable |
| Use of KeeperHub surfaces | Protocol plugins, simulate, audit trail, notifications, execution |
| Reliability & observability | Event-driven monitor + bot watch-loop backup + simulate-first + gas backoff + retries + audit trail = the core loop |
| Originality & usefulness | "Don't get liquidated while you sleep" is a use case people actually run |
| Integration quality | Clean separation: KeeperHub owns execution, LLM owns judgment, thin glue |

## Components

- **`server/event-watcher.ts`** — the primary, always-on watcher. Polls the Aave Pool's logs for
  the events that move a health factor and re-checks affected positions immediately, handing off
  to the decision layer when one drops below the act-threshold. The bot's watch loop is the
  deterministic backup.
- **`src/agent/`** — the LLM decision layer. Receives position snapshot, returns a structured
  decision `{ action: "repay"|"supply", token, amount, reasoning }`, then calls KeeperHub to execute.
  Lever executability is checked before the LLM: repay/supply are only offered when the wallet
  balance and Aave Pool allowance cover the sized amount — simulate-first is the final safety net,
  not the first one.
- **Gas awareness:** `buildSnapshot` fetches the network gas price (`eth_gasPrice` via the public
  RPC) + the ETH/USD price, and `computeCandidates` attaches an estimated `gasCostUsd` per lever
  (repay ≈150k gas, supply ≈200k — an estimate for the LLM's cost comparison; the authoritative
  number is the simulate step's gas estimate). When gas is known, the prompt asks the LLM to pick
  the lever at the **lowest total cost (tokens + gas)**; when the RPC is down it degrades to the
  capital-efficiency guidance. On Sepolia gas is sponsored by KeeperHub (often $0), so the figure
  is mostly informational there — but the mechanism is real and matters on chains without
  sponsorship.
- **`scripts/`** — setup & verification: first-tx dry-run, health checks, sizing tests.
- **`server/` + `web/`** — the hosted face: an observer dashboard **and** a Telegram bot, in one
  node process (port 8787). `server/` holds each user's KeeperHub key **encrypted at rest**
  (AES-256-GCM) in a Redis-backed store (`server/store.ts`), keyed by an HttpOnly cookie for the web
  session and by verified Telegram user id for the bot. `web/` is a TanStack Start (React + Vite +
  nitro) app — a pure viewer that doubles as the Telegram Mini App, with the API running as
  in-process server functions. The browser/chat never sees the key and
  never connects or signs a wallet. Execution stays entirely on the KeeperHub side, exactly as the CLI
  path.

## Telegram bot + Mini App (the phone-native face)

Real DeFi users live on their phones, and a liquidation guardian's value is in *pushing* the instant
health factor drops. The bot (`server/bot.ts`) closes that gap:

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


## The event-driven watcher (the primary "watches" half)

The always-on watching is **not** a KeeperHub workflow anymore — that was a deprecated experiment
(a Schedule → read Aave HF → Condition graph). The production watcher is our own **event-driven
watcher** (`server/event-watcher.ts`): it polls the Aave Pool's logs for the events that actually
move a position's health factor — `Supply`, `Repay`, `Borrow`, `Withdraw`, `LiquidationCall`, and
(oracle price updates) `ReserveDataUpdated` — and re-checks the affected positions immediately.

This is the difference between *reacting to the chain* and *waiting for the clock*: a relevant
event (a big withdraw, a liquidation, an oracle move) triggers a KeeperHub re-read of every stored
position within ~1 block of the change, instead of up to `WATCH_INTERVAL_MS` (60s) for the bot loop.
The topic hashes are keccak256 of the canonical Aave v3 Pool event signatures, cross-verified
against live Sepolia logs.

Layering (belt and suspenders, matching the reliability story):

1. **Event-driven watcher** — the fast reactive layer; reacts within ~1 block.
2. **Bot watch loop** — the deterministic backup; re-reads every position on a schedule.

The price-event topic (`ReserveDataUpdated`) fires constantly (oracle heartbeats), so it is
**throttled** (`PRICE_EVENT_THROTTLE_MS`, default 30s) — it only triggers a re-check if no other
event has fired within the window. Per-position re-reads are coalesced (`MIN_RE_READ_MS`, default
15s) so an event burst never hammers KeeperHub's rate limit. The watcher never executes anything
itself — it only *fires the existing check path sooner* (`bot.runCheck`), so the decision and
execution pipeline is unchanged.

The RPC reads behind this (pool event logs, `eth_blockNumber`, rescue-history backfill) go through a
provider-rotating client (`server/rescues.ts`) that fails over between RPC endpoints, cools down a
flaky provider for 60s, and paces in-flight requests — so a single flaky public node can't stall
the watch.

## Execution safety: simulate, broadcast, settle, verify

Every write goes through KeeperHub's `simulate: true` preflight first. Only if the result is
`success: true` and `wouldRevert: false` do we re-issue the call for real, with a unique
`idempotency_key`. A rescue is only reported as a success after **two** independent gates:

1. **Terminal settlement** — the transport (`rest` or `mcp`) polls the execution until
   `confirmed`, `reverted`, or `failed` (`src/verification.ts` normalizes both backends' status
   vocabulary; a timeout surfaces as `broadcast_pending`, never as a silent success).
2. **Onchain verification** — `src/transaction-verifier.ts` reads the transaction **receipt via
   the public RPC** (`server/rescues.ts` provider-rotating client), asserts receipt status `1`,
   and decodes the Aave `Repay`/`Supply` event from the Pool logs, matching the reserve, user,
   and exact base-unit amount we sized. A mismatch returns `verification_failed` with the reason.

This is what makes the demo independently verifiable (`npm run verify-demo`): the receipt and
event proof are reproduced from the chain, not from KeeperHub's status field. The gas cost is
computed as `gasUsed × effectiveGasPrice` in bigint and surfaced on the result.

## Durable watcher recovery + per-wallet rescue locking

The watcher persists its **block cursor in Redis** (`guardian:watcher-cursor`) after every poll
and resumes from it on restart — a redeploy re-scans nothing and misses no window. The rescue
path is serialized per position with a **Redis-backed lock** (`guardian:rescue-lock:{chain}:{wallet}`,
`SET NX PX` with an owner-checked Lua release, 120s TTL): the Telegram approval path and the
autonomous `/auto` path both acquire it before executing, so a double-tap or a concurrent watch
tick can never broadcast two rescues against the same wallet. Lock semantics are gated in
[scripts/test-rescue-lock.ts](../scripts/test-rescue-lock.ts) and status classification in
[scripts/test-watcher-state.ts](../scripts/test-watcher-state.ts).

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

The demo loop:
`npm run setup-position` opens a fresh at-risk position (borrows up to ~97% of capacity, HF just
above 1.0) → `LLM_TIMEOUT_MS=60000 npm run kh -- rescue --transport mcp --json` reads it, the
decision layer (any OpenAI-compatible provider, configured via `LLM_API_KEY`/`LLM_BASE_URL`/
`LLM_MODEL`) picks repay vs. supply, REST performs the no-broadcast simulation preflight, KeeperHub's
hosted MCP broadcasts and settles, and the verifier re-reads the receipt + Aave `Repay`/`Supply`
event from a public RPC before reporting success (`npm run verify-demo` reproduces it for any tx —
the productized form of TEARDOWN F9).

## Resolved earlier open questions

- **Is `aave-v3` on Sepolia?** Yes — confirmed live (this build's real rescue ran there).
- **Gas sponsorship on testnets?** Yes — Sepolia transfers were fully gas-sponsored (balance
  untouched to the wei), despite the docs saying "mainnet only" (TEARDOWN F4).
- **Are Stripe / x402scan surfaces live?** Not in the current docs; nothing in this build depends on
  them (TEARDOWN F1).
