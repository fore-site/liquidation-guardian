# Demo Walkthrough — Liquidation Guardian

The money shot: **a hosted LLM (OpenAI-compatible provider) decides the fix, KeeperHub executes it onchain.**

## Setup checklist (before you start)

```bash
# 1. Env — make sure a stale shell BASE_URL / ANTHROPIC_API_KEY can't shadow .env
unset BASE_URL ANTHROPIC_API_KEY 2>/dev/null
# .env needs: KEEPERHUB_API_KEY, WALLET_ADDRESS,
#             LLM_API_KEY + LLM_BASE_URL (provider /v1) + LLM_MODEL
#             e.g. OpenRouter: LLM_BASE_URL=https://openrouter.ai/api/v1,
#                  LLM_MODEL=deepseek/deepseek-v4-flash-0731

# 2. Sanity — everything green
npm install
npm run typecheck
npm run test-sizing

# 3. (Optional, for the dashboard/bot) Redis + the hosted face
redis-server &            # or point REDIS_URL at a hosted Redis
npm run dev:api           # terminal 1 — API + bot on :8787
npm run dev:web           # terminal 2 — dashboard on :5173 (proxies /api)
```

> **HF gotcha:** the position starts healthy (HF ~2.99). The walkthrough *opens a fresh at-risk
> position*, so `setup-position` is always the first onchain step — don't run the "at risk" read
> against a healthy wallet.

## The loop (≤3 minutes)

| # | Step | What's on screen | What's happening |
|---|---|---|---|
| 1 | Repo + README (10s) | `git log --oneline`, README top | "Event watcher watches, LLM decides, KeeperHub executes. Our event-driven watcher tracks the Aave pool's events; when the health factor nears liquidation, an LLM picks the cheapest fix and KeeperHub executes it onchain — simulated first, never blind." |
| 2 | Open an at-risk position (30s) | `npm run setup-position` | "Sepolia only lets us demo a single-asset LINK position, which is actually the cleanest case: the rescue amount is exact token math, no oracle." Ends with **HF just above 1.0**. |
| 3 | **The money shot — LLM decides** (40s) | `npm run guardian -- --dry-run` | "HF is below the 1.15 threshold. The decision layer asks the hosted LLM (OpenAI-compatible provider) which lever to pull — repay debt or add collateral — and why. It weighs the cost of each fix, including the gas estimate. Amounts are still computed in code; the model owns the choice + rationale." Freeze on the `Decision: repay <n> LINK — <model reasoning>` line. Must NOT say "Deterministic fallback". |
| 4 | Live rescue (40s) | `npm run guardian` (real) | "Same decision, real execution. KeeperHub simulates first — clean — then broadcasts and confirms. Here's the tx." Freeze on the `transactionLink`. |
| 5 | Onchain proof (20s) | Etherscan + RPC `eth_getLogs` | "Independently verified: the Aave Pool `Repay` event matches the computed amount — not just the API saying success." |
| 6 | The observer faces (10s) | Dashboard `/api/status`, Telegram `/status` + buttons | "The same engine behind a dashboard and a Telegram bot — the key never leaves the server, approvals are one tap." |
| 7 | Closing (10s) | Repo + tx link | "Reliability is the product: simulate-first, deterministic monitor, gas-sponsored execution through KeeperHub." |

## Why it works

- **Executes onchain via KeeperHub** — the rescue tx, end of story.
- **Reliability & observability** — deterministic monitor + simulate-first + retries + audit trail is
  the entire product: "a retry that lands the tx saves real money."
- **Use of KeeperHub surfaces** — protocol plugins, simulate, audit trail, gas sponsorship.
- **Originality** — "don't get liquidated while you sleep"; the LLM is reserved for the judgment
  call, never trusted with arithmetic.

## Gotchas that will bite a fresh run

- **Stale shell `BASE_URL` / `ANTHROPIC_API_KEY`** (e.g. `https://agentrouter.org`) used to shadow
  `.env` in earlier provider setups — the LLM clients no longer read them, but unset them anyway to
  avoid confusion. The provider is configured via `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`.
- **A slow or rate-limited LLM provider** falls back to deterministic sizing (`decideRescueWithLlm`)
  — the position stays protected. The dry-run decision step can be re-run freely.
- **Every write simulates first** — a `--dry-run` guardian simulates too, so it's free to iterate on
  the decision step as many times as needed.
- **`setup-position` mints 300 LINK** via the faucet each run (collateral + a rescue-repay buffer) —
  fine on testnet, just know the wallet balance grows.
