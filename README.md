# Liquidation Guardian

> **Event watcher watches. LLM decides. KeeperHub executes.**

Liquidation Guardian protects Aave borrow positions before they cross the liquidation line. It watches the events that move a position, asks an LLM to choose between a valid repay or supply path, sizes the action with deterministic fixed-point arithmetic, simulates the write, and executes through KeeperHub.

This is not a dashboard mockup. It has executed real Aave rescues on Ethereum Sepolia through KeeperHub.

## Why this is interesting

Liquidation is not mainly a prediction problem. It is a last-mile reliability problem:

1. A position becomes unsafe while its owner is away.
2. The system must recognize the change quickly.
3. It must choose a sensible intervention.
4. The intervention must be valid, funded, approved, simulated, broadcast, and confirmed.
5. The result must be observable and independently verifiable.

Liquidation Guardian separates those responsibilities instead of asking one model to do everything:

| Layer | Responsibility |
|---|---|
| Event watcher | Detect Aave Pool events and re-read affected positions. |
| LLM | Choose the rescue lever and explain the choice. |
| Deterministic code | Compute the exact token amount and reject unavailable levers. |
| KeeperHub | Simulate, execute, sponsor gas, retry requests, and report execution status. |
| Audit layer | Preserve a redacted lifecycle record for the dashboard and CLI. |

## Verified LLM + MCP rescue

The latest recorded rescue used the configured LLM for the decision and KeeperHub's hosted MCP path for the real broadcast.

- **Network:** Ethereum Sepolia
- **Trigger HF:** `1.0842`
- **LLM decision:** repay `257.82195864524175 LINK`
- **MCP execution ID:** `40747p27jahy0w0zui1a4`
- **Transaction:** [`0x3b056fd6…`](https://sepolia.etherscan.io/tx/0x3b056fd69281dfdc4413094684983604046b66902f77cfe88e8d5da960aa88b9)
- **Receipt:** verified success at block `11475458`
- **Result HF:** `1.0842 → 1.5029`
- **Gas:** `206,425` units, sponsored

The LLM selected repayment because it directly reduced the debt and the supply alternative was unavailable under the current Pool allowance. The amount was still computed by code, not invented by the model.

See the full evidence in [`docs/RESCUE_TX.md`](docs/RESCUE_TX.md).

## The core design choice: model for judgment, code for arithmetic

The model never supplies an executable amount. It selects an action and asset from candidates already sized and validated by code.

```ts
// src/agent/decide.ts
const decision = await decideRescue(opts.client, {
  ...opts.input,
  model: opts.model,
  timeoutMs: opts.timeoutMs,
});
return { decision, source: { provider: "llm" } };
```

The candidate layer checks balances, allowances, prices, and target reachability. If the LLM is unavailable, the deterministic fallback keeps the position protected:

```ts
// src/agent/decide.ts
const candidates = computeCandidates(snap, hfTarget, bufferBps);
const repays = candidates.filter((c) => c.action === "repay" && c.available && c.amountUnits > 0n);
```

**Trade-off:** this is less open-ended than a general tool-using agent, but it makes the safety boundary auditable. The model can choose poorly only within a closed set of executable, code-sized actions.

## Simulate first, then execute

Every rescue passes through one execution boundary:

```ts
// src/agent/guardian.ts
const sim = await transport.simulateAction(actionType, body);
if (!sim.success || sim.wouldRevert) {
  return { status: "simulation_failed", position, decision, detail };
}

if (opts.dryRun) {
  return { status: "rescued", position, decision,
    detail: "dry-run: simulated only, not broadcast." };
}

const exec = await transport.executeAction(actionType, body);
```

This protects the normal REST path and the MCP path. KeeperHub's hosted MCP protocol-action tool does not provide a reliable no-broadcast simulation envelope for this Aave action, so the MCP transport deliberately uses the existing REST client for simulation and MCP only for the real broadcast:

```text
REST simulation → MCP execute_protocol_action → MCP execution status
```

**Trade-off:** the MCP path is hybrid rather than pure MCP. That is intentional. A pure-looking integration that can accidentally broadcast during a “dry run” is worse than a split transport with a clear safety invariant.

## KeeperHub integrations

### REST execution

REST is the default and fallback transport. Existing scripts and server paths continue to work when MCP is unavailable.

```ts
// src/execution-transport.ts
export class RestExecutionTransport implements ExecutionTransport {
  readonly name = "rest" as const;

  async simulateAction(actionType: string, body: Record<string, unknown>) {
    const result = await this.keeperHub.executeAction(actionType, body, {
      simulate: true,
    });
    return { success: result.success, error: result.error };
  }
}
```

### Hosted MCP

The project connects to `https://app.keeperhub.com/mcp` using the organization API key as a bearer credential. The adapter discovers tools, searches Aave protocol actions, executes the real protocol action, and retrieves direct execution status.

```ts
// src/keeperhub-mcp.ts
this.client = new Client({
  name: "liquidation-guardian",
  version: "0.1.0",
});

this.transport = new StreamableHTTPClientTransport(
  new URL(config.url),
  { requestInit: { headers: {
    Authorization: `Bearer ${config.apiKey}`,
  } } },
);
```

The real execution call is explicit and idempotent:

```ts
// src/keeperhub-mcp.ts
await this.callTool("execute_protocol_action", {
  actionType,
  params: { ...params, idempotency_key: idempotencyKey },
});
```

Probe the live tool inventory without broadcasting:

```bash
npm run mcp-probe
```

### CLI

The CLI is a thin façade over the existing Guardian engine. It does not duplicate sizing or execution logic.

```bash
npm run kh -- position
npm run kh -- candidates
npm run kh -- rescue --dry-run --transport mcp --json
npm run kh -- rescue --transport mcp --json
```

The rescue output includes the run ID, provider, selected action, deterministic amount, transport, transaction link, and audit phases.

### Application audit trail

The server stores a capped, redacted lifecycle history in Redis. It distinguishes this application audit from KeeperHub's native execution records and from chain-derived Aave rescue history.

Recorded phases include:

- simulation
- broadcast
- confirmation
- failure

The dashboard exposes the latest records in its **Guardian audit trail** panel. The CLI exposes a sanitized audit summary for one-shot runs.

```ts
// src/audit.ts
export async function safeAudit(
  sink: AuditSink | undefined,
  event: Omit<AuditEvent, "at">,
): Promise<void> {
  if (!sink) return;
  try {
    await sink.record(auditEvent(event));
  } catch {
    // Audit persistence must never block or falsify a rescue.
  }
}
```

**Trade-off:** the application audit is best-effort and redacted. Onchain receipts remain the source of truth for whether a transaction happened. A Redis outage must not turn a successful broadcast into a failed rescue.

### Other KeeperHub surfaces

| Surface | Status | Project decision |
|---|---|---|
| REST API | Used | Default execution path and fallback. |
| Hosted MCP | Used | Real execution path with REST simulation preflight. |
| Project CLI | Used | Judgeable interface over the same engine. |
| Application audit | Used | Lifecycle visibility in Redis, dashboard, and CLI. |
| x402 / MPP | Not integrated | No paid transport in the safety-critical rescue path. |
| Workflow builder | Not integrated | The event-driven watcher reacts faster than the earlier scheduled workflow experiment. |
| KeeperHub native audit retrieval | Not claimed | The project shows its own audit plus onchain evidence. |

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the complete matrix and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design.

## Why the demo uses LINK on Sepolia

The project supports a reserve registry, but a listed reserve is not automatically usable. A reproducible demo asset needs:

- supply-cap room;
- borrow liquidity;
- faucet availability;
- wallet balance and Pool allowance support;
- a successful KeeperHub execution path.

On the Sepolia deployment tested for this project, stablecoin supply attempts hit supply caps and stablecoin borrows had no usable liquidity. WBTC and AAVE had some supply capacity, but no equally reliable faucet plus borrow path was demonstrated. LINK was the only asset that satisfied the complete setup and rescue path, so the demo uses LINK collateral and LINK debt.

This is also a useful technical trade-off. With a single asset on each side, the price cancels from the health-factor equation, so the rescue amount is exact token arithmetic:

```text
HF = collateral × liquidationThreshold / debt
repay R = debt × (1 − HF / target)
```

That makes the core rescue easy to verify without depending on a price oracle. The decision layer still supports multi-asset positions and price-aware sizing when a side contains multiple assets.

See [`docs/TEARDOWN.md`](docs/TEARDOWN.md) for the live reserve investigation and [`src/agent/assets.ts`](src/agent/assets.ts) for the registry.

## Event-driven monitoring

The watcher polls Aave Pool logs for the events that can move a position:

- Supply
- Repay
- Borrow
- Withdraw
- LiquidationCall
- ReserveDataUpdated

It re-reads affected positions, throttles noisy price events, coalesces repeated reads, and hands the decision to the existing Guardian engine. The scheduled bot loop remains a backup rather than the primary trigger.

**Trade-off:** this adds RPC cursor and event-indexing complexity, but it reacts to the chain rather than waiting for a coarse timer. The execution path stays shared, so event-driven, Telegram, and CLI triggers do not each implement their own rescue logic.

## Dashboard and Telegram

The web app is an observer and control surface, not a wallet. It shows:

- live health factor and risk state;
- collateral, debt, and borrowable value;
- available rescue paths;
- health-factor history;
- chain-derived rescue history;
- application execution audit trail;
- pause/resume and threshold controls;
- Telegram connection state.

The API key never reaches the browser. The server encrypts it with AES-256-GCM in Redis and uses an HttpOnly session cookie. Telegram onboarding uses signed Mini App `initData`; the key is never sent through chat.

```bash
# Local dashboard + API + optional bot
npm run dev:api

# Or run the production container with Redis
docker compose up --build
```

## Quick start

1. Create a KeeperHub organization API key from the Organisation API Keys page.
2. Fund the KeeperHub wallet with Sepolia ETH if your account requires it.
3. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

4. Set `KEEPERHUB_API_KEY`, `WALLET_ADDRESS`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`.
5. Install dependencies and run the local gates:

   ```bash
   npm install
   npm run typecheck
   npm run test-sizing
   npm run test-security
   npm run test-mcp
   npm run test-audit
   ```

6. Run the demo:

   ```bash
   npm run setup-position
   LLM_TIMEOUT_MS=60000 npm run kh -- rescue --dry-run --transport mcp --json
   LLM_TIMEOUT_MS=60000 npm run kh -- rescue --transport mcp --json
   ```

## Repository layout

```text
src/agent/       LLM decision layer, candidate sizing, Guardian orchestration
src/keeperhub.ts REST client with retries, idempotency, and execution polling
src/keeperhub-mcp.ts hosted KeeperHub MCP client
src/audit.ts     redacted audit contract and best-effort sink interface
server/          encrypted store, Redis audit, event watcher, Telegram bot, API
web/             TanStack Start dashboard and Telegram Mini App
scripts/         CLI, MCP probe, setup, dry-runs, and verification checks
docs/            architecture, teardown, integration matrix, demo, and transactions
```

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — event watcher, decision layer, sizing, and execution safety
- [`docs/RESCUE_TX.md`](docs/RESCUE_TX.md) — verified rescue transactions and onchain evidence
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — KeeperHub surface matrix
- [`docs/TEARDOWN.md`](docs/TEARDOWN.md) — what was tested, what failed, and why the architecture changed
- [`docs/PITCH_DECK.md`](docs/PITCH_DECK.md) — concise product narrative

## Project status

The core execution path is working and verified on Sepolia. The project deliberately prioritizes a bounded decision space, deterministic amounts, simulation before broadcast, explicit MCP/REST transport behavior, and independently verifiable transactions over a broader but less reliable set of integrations.
