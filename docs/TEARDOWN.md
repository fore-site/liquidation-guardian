# Zero → First Transaction: A Fresh Builder's Teardown

> **Bounty submission — Best Onboarding UX Improvement.**
> This is a real-time log of getting from *never used KeeperHub* to *first transaction executed*,
> written by a builder with strong general coding skills but **zero web3/DeFi background**. Every
> point of friction is recorded as it happened, with a proposed fix. The goal: make the next
> person's zero-to-first-tx faster.

## Who I am (calibration)

- Comfortable: Python/JS/TS, terminal, wiring APIs, reading docs.
- Not comfortable: crypto/DeFi concepts, wallets, gas, onchain execution. First time touching a chain.

If something tripped *me* up, it will trip up the wave of AI-agent builders coming from web2.

---

## Friction log

Format: **[F#] What I hit → Why it's confusing → Proposed fix.**

### [F1] The brief promises surfaces the docs don't mention
- **Hit:** The hackathon brief names Stripe integration, x402scan.com indexing, and mainnet gas
  sponsorship. None of these appear in the current docs (agentic-wallet, mcp-server, main).
- **Confusing because:** As a newcomer I can't tell if I'm missing a page or the feature isn't live.
  I don't know which source of truth wins.
- **Proposed fix:** Reconcile brief ↔ docs, or add a "Hackathon: what's live vs. roadmap" note so
  builders don't design around features that aren't shipped.

### [F2] The CLI quickstart doc page is broken
- **Hit:** `https://docs.keeperhub.com/cli/quickstart` returned an empty/malformed 200, and
  `https://docs.keeperhub.com/cli/overview` returned 404. I could not find the exact npm package
  name for the `kh` CLI or its non-interactive auth command from the docs.
- **Confusing because:** The CLI is listed as a headline surface, but a newcomer can't install it
  from the docs. I didn't want to guess an npm package name (typosquatting risk), so I fell back
  to the REST API.
- **Proposed fix:** Restore the CLI quickstart/overview pages; state the exact package name and the
  env var / flag for API-key auth up front.

### [F3] Etherscan shows a transaction that looks nothing like what you sent — THE big one
- **Hit:** I asked KeeperHub to send 0.001 ETH from my wallet to itself. The API
  returned success + a real tx hash. But on Etherscan the transaction reads:
  `from 0xa17c… (a stranger)  →  to 0x5af5… (a contract)`, `value: 0 ETH`, `gas used: 74793`.
  None of the three top-level values (from, to, value) match what I sent.
- **Confusing because:** As a newcomer this is alarming — *did it work? did someone hijack my
  transfer? where's my 0.001 ETH?* Nothing on the Etherscan summary line reassures you.
- **What's actually happening** (took manual calldata decoding to confirm):
  - KeeperHub uses a **relayer + router** model. A KeeperHub keeper EOA (`0xa17c…`) submits the
    tx and **pays the gas**, calling a KeeperHub **router contract** (`0x5af5…`).
  - Your intent is encoded in the **calldata**: selector `0x9aefaff8`, then
    `(owner=<your wallet>, recipient=<your wallet>, amount=0x038d7ea4c68000 = 0.001 ETH, + a 65-byte
    signature)`. The self-transfer is real; it's just an *internal* transfer done by the router,
    which is why the top-level `value` is 0 and gas is 74793 (contract call) not 21000 (bare send).
  - Your KeeperHub wallet is **not a plain EOA** — it has 23 bytes of code:
    `0xef0100 955d84139e7621bc571b117d8eb5d28a4a222c6f`. That's an **EIP-7702 delegation** to a
    smart-account implementation (`0x955d84…`). Turnkey provisions a smart account.
  - **Gas was sponsored on Sepolia:** my wallet balance was 0.05 ETH before and 0.05 ETH after,
    to the wei. The keeper paid.
- **Proposed fix:** A short docs page — "Understanding your transaction on a block explorer" —
  showing this exact pattern: here's the keeper, here's the router, here's where your intent lives
  in calldata, here's why value=0, here's the internal transfer, and "your balance funds nothing;
  gas is sponsored." One annotated Etherscan screenshot would save every web2 newcomer a panic.
  Also: the API response could include an `internalTransfers` or `effectiveFrom/effectiveTo`
  field so builders don't have to decode calldata to confirm what moved.

### [F4] Brief said gas sponsorship is "mainnet Ethereum" — but Sepolia was sponsored too
- **Hit:** The hackathon brief states gas sponsorship is offered "on mainnet Ethereum." In
  practice my Sepolia transfer was fully gas-sponsored (balance untouched).
- **Proposed fix:** Clarify where sponsorship applies. If testnets are sponsored too, say so —
  it's a big selling point for builders worried about faucet funds.

### [F5] Which reserves actually work is undocumented — you find out by reverting
- **Hit:** Building the demo position, my first instinct was a "normal" DeFi setup: stablecoin
  debt (USDC/DAI) against volatile collateral. Every stablecoin path failed onchain, each with a
  different opaque error:
  - **Supply USDC/DAI/USDT → `Error(51)`** = `SUPPLY_CAP_EXCEEDED`. These reserves are already at
    their supply cap on this Sepolia deployment; you cannot add collateral.
  - **Borrow a stablecoin → `Panic(17)`** (arithmetic underflow) = the reserve has no borrow
    liquidity to draw from. Nothing to borrow.
  - Only **LINK, WBTC, AAVE** have supply-cap room, and of those only **LINK** is faucet-mintable
    and has borrow liquidity. So the *only* viable single-wallet demo is LINK collateral + LINK debt.
- **Confusing because:** `Error(51)` and `Panic(17)` are raw Solidity revert codes with no
  human-readable mapping in the API response. A newcomer has no way to know "this token is capped"
  vs. "I formatted the call wrong" — both just look like a failed simulation. I burned an hour
  assuming my calldata was wrong when the *asset itself* was unusable.
- **Proposed fix:** (1) Decode known protocol revert codes in the API/simulate response —
  `Error(51)` → `"Aave: SUPPLY_CAP_EXCEEDED"`. (2) Publish a per-chain "what's usable right now"
  table for supported protocols (which reserves have cap room / borrow liquidity / a faucet), or
  expose it via an endpoint. For a testnet demo this is the single most valuable missing doc.

### [F6] A single-asset position turned out to be the *right* call, not a compromise
- **Hit:** Forced into LINK-collateral + LINK-debt by F5, I worried it looked like a toy.
- **What I learned:** It's actually cleaner. When collateral and debt are the same asset, the token
  price cancels out of the health-factor formula (`HF = collateral·LT/debt`), so the rescue amount
  is exact token arithmetic with **no price oracle**. The agent never has to trust a price feed.
- **Proposed fix:** Not a bug — worth surfacing in docs as a recommended pattern for deterministic
  agents: single-asset positions are oracle-free and the easiest correct thing to demo.

### [F7] `contract-call` silently ignores `args`; the real field is a JSON-encoded *string*
- **Hit:** To hit the faucet's `mint(...)` and ERC-20 `approve(...)`, I needed the generic
  `contract-call` action. I passed a normal JSON array as `args` — the call simulated as a no-op
  (the args were dropped, count=0). Passing a real array under `functionArgs` returned
  `"Invalid field type"`. What finally worked: `functionArgs` set to a **JSON-encoded string** of
  the array, e.g. `functionArgs: "[\"0xabc…\",\"1000\"]"` (stringify the array, don't pass it raw).
- **Confusing because:** Three failure modes that all look similar — wrong field name (silently
  ignored, no error), right field with wrong type (`Invalid field type`), right field with the
  right type but not stringified. None of them says "you're close, just JSON-encode this."
- **Proposed fix:** Document `contract-call` with a concrete example showing `functionArgs` as a
  JSON string. Either accept a real array too, or return a targeted error
  (`"functionArgs must be a JSON-encoded string"`) instead of the generic type error.

### [F8] Node's `fetch` times out where `curl` succeeds — Happy-Eyeballs on IPv6-advertised networks
- **Hit:** Every `fetch()` to `app.keeperhub.com` threw `ETIMEDOUT`, while `curl` to the same URL
  worked instantly. No proxy, no firewall difference.
- **What's actually happening:** This network advertises IPv6 but drops it. Node's undici uses a
  250 ms Happy-Eyeballs timer before failing over IPv6 → IPv4; on a black-holed-IPv6 network that
  window is too short, so the connection dies before the IPv4 attempt. `curl` fails over faster.
- **Fix (mine, not KeeperHub's):** `net.setDefaultAutoSelectFamilyAttemptTimeout(2000)` before the
  first fetch (see [src/net.ts](../src/net.ts)), imported first in every entrypoint. A 401 (reached
  the server) immediately confirmed it.
- **Proposed fix for docs:** A one-liner in the SDK/quickstart troubleshooting — "if Node `fetch`
  times out but `curl` works, bump the autoSelectFamily timeout" — would save a Node builder an
  afternoon. This bites the exact web2 audience KeeperHub is courting.

### [F9] Etherscan's V1 API is deprecated — verifying your own tx needs an RPC fallback
- **Hit:** To independently confirm the rescue (not just trust the API's `success:true`), I tried
  the Etherscan V1 API to pull the Aave `Repay` event — it returned `NOTOK` (V1 deprecated).
- **Fix:** Queried a public Sepolia RPC (`https://ethereum-sepolia-rpc.publicnode.com`) directly
  with `eth_getLogs` for the Pool's `Repay` topic. Found exactly one event, amount 18.0917 LINK,
  matching the agent's computed rescue — clean, provider-free verification.
- **Proposed fix:** KeeperHub's execution-status response could include decoded emitted events
  (or effective transfers) so builders can confirm *what moved* without hand-rolling `eth_getLogs`.
  Ties back to the F3 fix — the recurring theme is "help me see what actually happened onchain."

### [F10] KeeperHub's *named* Chainlink feed actions aren't all deployed per-chain
- **Hit:** Adding multi-asset sizing, I needed USD prices. KeeperHub exposes named Chainlink
  actions (`chainlink/eth-usd-latest-round-data`, `chainlink/link-usd-latest-round-data`, …). On
  Sepolia, `eth-usd` and `btc-usd` resolved fine, but `link-usd` and `usdc-usd` both failed with
  `"Protocol chainlink contract linkUsd/usdcUsd is not deployed on chain 11155111"` — even though
  those feeds *do* exist on Sepolia at well-known addresses.
- **Confusing because:** The named actions look chain-agnostic, so a newcomer assumes "if `eth-usd`
  works, `link-usd` works." The failure is a per-chain registry gap in the named-feed map, not a
  missing feed onchain — but the error reads like the feed doesn't exist.
- **Fix (mine):** Use the **generic** `chainlink/latest-answer` action with an explicit feed
  `contractAddress` instead of the named actions. One code path, portable across chains, no
  named-feed coverage gaps. I keep a small symbol→address map of verified Sepolia feeds in
  [src/agent/prices.ts](../src/agent/prices.ts); assets without a feed return `null` and the agent
  simply won't act on that side (never guesses a price).
- **Proposed fix for KeeperHub:** Either backfill the named-feed registry per supported chain, or
  document that `latest-answer` + address is the portable path and list the known feed addresses
  per chain. A one-line note ("named feeds are curated per chain; use latest-answer for full
  coverage") would save the guessing.

### [F11] Deploying a workflow by API: HTTP-Request is Pro-gated, and there's no REST create
- **Hit:** Building the original "watches" half — a Schedule → read Aave HF → Condition →
  HTTP-POST-to-Guardian workflow — two things bit in a row. (1) **No REST create:** `POST
  /api/workflows` returns `405 Method Not Allowed`. `GET`, `PATCH /:id`, and `DELETE /:id` all
  work, but creation is only via the MCP `create_workflow` tool or the web UI. (2) **HTTP Request
  is a paid node:** pushing the graph with the HTTP-Request handoff returns `402 { code:
  "upgrade_required", violations: [{ featureId: "action.http-request", requiredPlan: "pro" }] }`.
  Schedule, the Aave protocol read, and Condition are all free; only the outbound webhook needs Pro.
- **Confusing because:** The MCP/REST surfaces look interchangeable, so you reach for `POST
  /workflows` and get a bare 405 with no hint that create lives elsewhere. And the plan gate only
  trips on *write* of the full graph — `list_action_schemas` shows HTTP Request with no tier marker,
  so you don't learn it's Pro until the 402. A `DELETE` of an existing workflow with run history is
  also refused (`"delete executions first"`) with no documented endpoint to purge executions.
- **Fix (mine):** I eventually **deprecated the KeeperHub workflow entirely** and moved watching to
  our own event-driven watcher (`server/event-watcher.ts`) — it reacts to Aave Pool events within
  ~1 block, needs no Pro tier, no workflow API, and keeps the watch in our own process with the
  decision+execution half. The workflow experiment is documented here only for the record; the code
  (`src/workflows/`, `scripts/deploy-workflow.ts`) was removed.
- **Proposed fix for KeeperHub:** (a) Either expose `POST /api/workflows` for create or make the 405
  point at the MCP/UI path. (b) Surface plan tiers in `list_action_schemas` (a `requiredPlan` field)
  so gating is visible before a write. (c) Document an executions-purge endpoint, or allow
  `DELETE ?force=true` to cascade.

<!-- Append new friction points below as they occur during the actual build. -->
<!-- (F1–F11 recorded during the build.) -->

---

## What went smoothly (worth keeping)

<!-- Balance the teardown: note the things that were genuinely easy, so they don't get "fixed" away. -->

- The docs having a dedicated **Hackathon Quickstart** section signals the intended happy path clearly.
- **No private-key handling** (Turnkey auto-provision) removes the single scariest step for a newcomer.
- `simulate: true` preflight is a solid safety rail — it let me reason about a write before risking one.

---

## Proposed deliverable for the bounty

1. This teardown (friction + fixes).
2. A **starter template** (`create-guardian` style scaffold) that encodes the happy path we found:
   env setup, MCP connect, a working simulate→execute first-tx script, and a minimal workflow.
3. Any doc PRs the above surfaces (typos, missing steps, wrong chain IDs, etc.).
