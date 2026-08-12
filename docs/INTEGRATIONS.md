# KeeperHub integrations

## Active in this project

| Surface | Status | Role |
|---|---|---|
| REST API | Active | Default execution transport and fallback. |
| MCP server | Active | Explicit `EXECUTION_TRANSPORT=mcp` path through KeeperHub's hosted MCP endpoint. |
| Project CLI | Active | `npm run kh -- ...` interface over the existing Guardian engine. |
| Application audit trail | Active | Redis-backed lifecycle records for server rescues and sanitized CLI output for one-shot runs. |

## Not used in the rescue path

| Surface | Status | Reason |
|---|---|---|
| x402 / MPP | Not integrated | No paid transport is placed in the safety-critical rescue path. |
| Workflow builder | Not integrated | The project uses an event-driven Aave log watcher instead of a scheduled workflow. |
| KeeperHub native audit retrieval | Not claimed | The dashboard shows this application's redacted lifecycle audit plus onchain rescue history. |

## MCP transport

The MCP path uses `https://app.keeperhub.com/mcp` with the organization API key as a bearer token. It discovers KeeperHub tools and uses `execute_protocol_action` for the real Aave execution. The no-broadcast simulation preflight remains on the existing REST client because the hosted MCP protocol-action tool does not provide a reliable simulation envelope for this action; MCP is called only after REST simulation succeeds.

```bash
npm run mcp-probe
npm run kh -- position
npm run kh -- candidates
npm run kh -- rescue --dry-run --transport mcp
npm run kh -- rescue --transport mcp
```

REST remains the default:

```bash
npm run kh -- rescue --dry-run --transport rest
```

No command prints the KeeperHub API key or authorization header.
