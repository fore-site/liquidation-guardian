# Guardian Rescue

**The core demo: an at-risk Aave position, detected and rescued onchain via KeeperHub.**

This is the transaction the whole project exists to produce — the Liquidation Guardian
reading a live health factor, deciding the fix, sizing it with no oracle, and executing
the repay through KeeperHub.

## The rescue

- **Network:** Ethereum Sepolia (chainId 11155111)
- **Protocol:** Aave v3 — Pool `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`
- **Position owner:** the demo wallet (EIP-7702 smart account)
- **Trigger:** health factor **1.1029**, below the Guardian's action threshold (1.15)
- **Decision:** `repay 18.0917 LINK` of debt to restore HF toward the 1.5 target
- **Result:** health factor **1.1029 → 1.5027**
- **Rescue transaction:** `0x5683f7fbdf3c116c5956e1f771d985f04716c0ed8297adfde6a20cfb92758743`
- **Explorer:** https://sepolia.etherscan.io/tx/0x5683f7fbdf3c116c5956e1f771d985f04716c0ed8297adfde6a20cfb92758743
- **Block:** 11413635 · **Executed at:** 2026-08-03T23:43:00Z

## Verified onchain (not just an API `success:true`)

The repay was confirmed independently of KeeperHub's response, by querying the Aave Pool's
`Repay` event log for this user over recent blocks (public Sepolia RPC `eth_getLogs`):

```
found 1 Repay event(s): tx 0x5683f7fb… block 11413635 amount=18.0917 LINK
```

The amount matches the Guardian's computed rescue (18.091658946882983 LINK) exactly, and the
transaction went through KeeperHub's relayer path — same pattern verified in FIRST_TX.md:

- **Keeper EOA** `0xa17cb6adb58277e5b4a44b8c1ecb449bb6614e87` submitted the tx and paid gas (sponsored).
- **Router contract** `0x5af5194b4b0909eb978e3cf1e25333852277f07d`, calldata selector `0x9aefaff8`.

## No price oracle needed

The demo position is single-asset — **LINK collateral, LINK debt** (forced by what this Sepolia
deployment actually allows; see TEARDOWN.md F5/F6). That's not a shortcut. It makes the math exact.
Aave's health-factor identity is:

```
HF = collateral · liquidationThreshold / debt
```

When collateral and debt are the same asset, the token price cancels out of HF entirely. So the
rescue size is pure token arithmetic, no oracle, no price feed to trust:

```
repay R tokens to reach target:   R = debt · (1 − HF / target)
supply S tokens to reach target:  S = collateral · (target / HF − 1)
```

For HF 1.1029 → target 1.5 with a 0.5% buffer, that's `R ≈ 18.09 LINK` — computed in fixed-point
integer math in [src/agent/decide.ts](../src/agent/decide.ts), never trusting a floating-point or
model-produced number for the amount.

## Division of labor (what decided vs. what executed)

| Layer | Owns | In this rescue |
|---|---|---|
| Event-driven watcher (watch) | always-on HF monitoring, threshold trip | triggered on a pool event, HF < 1.15 |
| Decision layer ([decide.ts](../src/agent/decide.ts)) | repay-vs-supply *choice* + rationale | chose `repay` (capital-efficient) |
| Fixed-point sizing (code, no oracle) | the *amount* | 18.0917 LINK |
| KeeperHub execution | simulate → broadcast → confirm | tx `0x5683f7fb…` |

> **Note on this specific run:** it executed via the **deterministic fallback** decision path.
> No LLM key was configured, so the Guardian used its LLM-free sizing to stay protected.
> The choice was the obvious one (repay, since debt is on hand) and the amount is identical either
> way, since the arithmetic is deterministic regardless of who picks the action. The LLM-in-the-loop
> path (a hosted OpenAI-compatible model choosing repay vs. supply and explaining it) is wired and
> ready; it needs a fresh at-risk position to demo, since HF is now healthy at 1.5027.

## Fresh LLM + MCP rescue — 2026-08-12

A fresh at-risk position was rescued after the LLM dry-run selected the repay lever and the REST simulation preflight passed. The real broadcast used KeeperHub's hosted MCP `execute_protocol_action` tool.

- **Trigger HF:** 1.0842
- **LLM decision:** repay 257.82195864524175 LINK
- **Decision reasoning:** Repaying LINK debt directly reduces the debt balance and improves the health factor most efficiently; the supply lever was unavailable because its required amount exceeded the Pool allowance.
- **MCP execution ID:** `40747p27jahy0w0zui1a4`
- **Rescue transaction:** `0x3b056fd69281dfdc4413094684983604046b66902f77cfe88e8d5da960aa88b9`
- **Explorer:** https://sepolia.etherscan.io/tx/0x3b056fd69281dfdc4413094684983604046b66902f77cfe88e8d5da960aa88b9
- **Receipt:** verified success at block `11475458`
- **Result HF:** 1.0842 → 1.5029
- **Gas:** 206,425 units; sponsored

The no-broadcast preflight used the existing REST execution client because KeeperHub's hosted MCP protocol-action tool did not provide a reliable simulation envelope for this Aave action. MCP handled the real broadcast and execution status. The CLI run ID was `4ea0e985-c653-4eb1-b23a-0c104334b833`.

Independent verification now reproduces the receipt and event proof:

```bash
npm run verify-demo -- --tx 0x3b056fd69281dfdc4413094684983604046b66902f77cfe88e8d5da960aa88b9 \
  --action repay --asset LINK --amount 257821958645241734690
```

The verifier confirmed receipt status `1`, block `11475458`, gas used `206425`, gas cost `211800929990650` wei, and an exact Aave `Repay` event match.

## Reproduce

```bash
npm run setup-position
LLM_TIMEOUT_MS=60000 npm run kh -- rescue --dry-run --transport mcp --json
LLM_TIMEOUT_MS=60000 npm run kh -- rescue --transport mcp --json
```
