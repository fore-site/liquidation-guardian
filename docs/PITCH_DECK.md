# Product Pitch — Liquidation Guardian

Three-pillar structure for the product narrative and demo. Keep it to ~3 minutes.

## Opening (15s) — the pain

"DeFi borrow positions get liquidated while you sleep. Most 'bots' that promise
to help follow rigid rules — they act on a fixed number, not on what's actually
cheapest or safest for you."

## Pillar 1 — Dynamic Risk Awareness (45s)

**The LLM advantage, made true.** The Guardian reads the whole position picture:
health factor, collateral, debt, wallet balances, the Pool allowance, and — via
the live RPC — the current gas price. It sizes every fix (repay vs. add
collateral) exactly in code, then asks the LLM to pick the lever at the **lowest
total cost** (tokens spent + gas), with reasoning you can audit.

- Honest claim: it weighs the *cost of each fix*, not rigidity. Volatility
  forecasting is a roadmap item, not a live claim.
- Demo hook: `npm run guardian -- --dry-run` shows the `Decision:` line with the
  model's reasoning — and now the per-lever gas estimate.

## Pillar 2 — One-Click Strategy Blueprints (40s)

**No DeFi PhD required.** Two defense profiles in plain English, selectable in
onboarding — they preset real thresholds:

- **The Conservative:** "Prioritize absolute safety. Act early, repay debt as
  soon as it's affordable." (Higher act-threshold: 1.6.)
- **The Capital Efficient:** "Ride the edge. Act at the last safe moment to
  maximize yield." (Lower act-threshold: 1.1.)

The profiles are honest presets over the existing threshold/target engine — no
hidden strategy magic, fully adjustable after selection.

## Pillar 3 — Non-Custodial Trust (30s)

**The agent never holds your keys.** It carries only *limited execution
permission* — the ability to repay debt or add collateral on your position,
under EIP-7702 delegation / ERC-20 approvals. It **cannot** withdraw to an
external wallet. Your KeeperHub key is held server-side, encrypted at rest; the
browser and Telegram never see it.

## The ROI calculator (30s)

A prominent calculator on the landing page: pick an asset, a borrow amount, and
your health factor, and see the math of the pain you're avoiding:

- "If liquidated today, you face ~$X in liquidation penalty."
- "The Guardian's fix costs ~$Y (tokens + gas — sponsored on this demo chain)."
- "You avoid ~$Z by acting before liquidation."

Consumers buy when they see the exact numbers.

## Closing (20s) — why it matters

- **Executes onchain via KeeperHub** — the real rescue tx link
  (`0x5683f7fb…`), verified via `eth_getLogs`.
- **Use of KeeperHub surfaces** — protocol plugins, simulate-first, audit
  trail, gas sponsorship, execution.
- **Reliability & observability** — event-driven watcher + bot watch-loop
  backup + simulate-first + retries + audit trail.
- **Originality** — "the LLM is reserved for the judgment call, never trusted
  with arithmetic"; the cost-aware decision is the differentiator.
