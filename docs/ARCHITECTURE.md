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
   there's a real        │  LLM Decision Layer  (Claude)                │
   decision to make      │                                              │
                        │  Inputs: HF, collateral, debt, wallet        │
                        │  balances, gas cost of each option           │
                        │  Decides: repay vs add-collateral, + amount   │
                        │  to restore HF to TARGET at lowest cost       │
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
- **`scripts/`** — setup & verification: first-tx dry-run, health checks, sizing tests, workflow deploy.

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

## Demo plan (Sepolia)

Mainnet Aave positions are real money and slow to set up. For the demo we either:
1. Use a Sepolia Aave-v3 deployment with a test position we can push toward liquidation, **or**
2. If Sepolia Aave is unavailable/flaky, demo the full pipeline with a threshold-triggered
   `transfer`/`contract-call` as the "fix," and clearly note the Aave action is the production path.

Decision deferred until we confirm what's live on Sepolia via the MCP `search_protocol_actions` tool.

## Open questions to confirm in Discord #help

- Is `aave-v3` available on Sepolia (11155111) via KeeperHub, or only mainnet/Base?
- Gas sponsorship: brief says mainnet ETH; does it apply to our demo chain?
- Are Stripe / x402scan surfaces (mentioned in the brief) actually live? (Not in current docs.)
