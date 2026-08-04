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
5. **Connect the MCP server:**
   ```bash
   claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp \
     --header "Authorization: Bearer kh_your_key_here"
   ```
6. **Verify with a dry-run first tx** (simulate, no broadcast), then execute for real:
   ```bash
   npm run first-tx
   ```

## Repository layout

```
src/workflows/   KeeperHub workflow definitions (trigger + read + condition)
src/agent/       LLM decision layer (repay vs. add-collateral, + amount)
scripts/         Setup & verification (first-tx dry-run, health checks)
docs/            Architecture, teardown, and pitch material
```

## Why this fits the brief

The hackathon rewards agents that execute onchain reliably, not clever demos that never touch a
chain. Liquidation protection is a use case where reliability is the entire point: a retry that
lands a transaction saves the user real money. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the design maps onto the judging criteria.
