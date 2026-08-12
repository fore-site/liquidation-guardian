import "../src/net.js";
import OpenAI from "openai";
import { loadConfig } from "../src/config.js";
import { KeeperHub } from "../src/keeperhub.js";
import { KeeperHubMcpClient } from "../src/keeperhub-mcp.js";
import { createExecutionTransport } from "../src/execution-transport.js";
import { MemoryAuditSink, newAuditRunId } from "../src/audit.js";
import { buildSnapshot, runGuardianOnce } from "../src/agent/guardian.js";
import { computeCandidates } from "../src/agent/decide.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
const transportName = args.includes("--transport") ? args[args.indexOf("--transport") + 1] : undefined;
const dryRun = args.includes("--dry-run");

function output(value: unknown): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function llmFor(cfg: ReturnType<typeof loadConfig>) {
  return cfg.llmApiKey ? { client: new OpenAI({ apiKey: cfg.llmApiKey, baseURL: cfg.llmBaseUrl }), model: cfg.llmModel, timeoutMs: cfg.llmTimeoutMs } : null;
}

const cfg = loadConfig();
const keeperHub = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
let mcp: KeeperHubMcpClient | undefined;
try {
  if (command === "mcp-probe") {
    mcp = new KeeperHubMcpClient({ apiKey: cfg.keeperHubApiKey, url: cfg.keeperHubMcpUrl });
    output({ transport: "mcp", endpoint: cfg.keeperHubMcpUrl, tools: await mcp.listTools() });
  } else if (command === "position" || command === "candidates") {
    const position = await keeperHub.readAavePosition(cfg.chainId, cfg.walletAddress);
    if (command === "position") output({ healthFactor: position.healthFactor, totalCollateralUsd: position.totalCollateralUsd, totalDebtUsd: position.totalDebtUsd, availableBorrowsUsd: position.availableBorrowsUsd, liquidationThreshold: position.liquidationThreshold });
    else { const snapshot = await buildSnapshot(keeperHub, cfg.chainId, cfg.walletAddress, position); output({ healthFactor: position.healthFactor, candidates: computeCandidates(snapshot, cfg.hfTarget).map((candidate) => ({ action: candidate.action, asset: candidate.asset.symbol, amountHuman: candidate.amountHuman, available: candidate.available, reachesTarget: candidate.reachesTarget, note: candidate.note })) }); }
  } else if (command === "rescue") {
    const selectedTransport = transportName === "mcp" ? "mcp" : transportName === "rest" ? "rest" : cfg.executionTransport;
    if (selectedTransport !== "rest" && selectedTransport !== "mcp") throw new Error("Transport must be rest or mcp.");
    if (selectedTransport === "mcp") mcp = new KeeperHubMcpClient({ apiKey: cfg.keeperHubApiKey, url: cfg.keeperHubMcpUrl });
    const audit = new MemoryAuditSink();
    const runId = newAuditRunId();
    const result = await runGuardianOnce({ keeperHub, llm: llmFor(cfg), chainId: cfg.chainId, user: cfg.walletAddress, hfThreshold: cfg.hfThreshold, hfTarget: cfg.hfTarget, dryRun, maxSteps: 1, transport: createExecutionTransport({ transport: selectedTransport, keeperHub, mcp }), audit: { sink: audit, runId, source: selectedTransport === "mcp" ? "mcp" : "cli", threshold: cfg.hfThreshold, target: cfg.hfTarget } });
    output({ runId, transport: selectedTransport, provider: result.provider ?? (cfg.llmApiKey ? "llm_or_fallback" : "deterministic"), status: result.status, healthFactor: result.position.healthFactor, decision: result.decision ? { action: result.decision.action, asset: result.decision.asset, amountHuman: result.decision.amountHuman, reasoning: result.decision.reasoning } : undefined, transactionLink: result.transactionLink, detail: result.detail, audit: audit.events.map((event) => ({ phase: event.phase, at: event.at, success: event.success, status: event.status, executionId: event.executionId, transactionLink: event.transactionLink, healthFactorBefore: event.healthFactorBefore, healthFactorAfter: event.healthFactorAfter })) });
  } else if (command === "audit") {
    output({ message: "Audit history is available in the hosted dashboard after a server-backed rescue. Use the dashboard audit panel for authenticated records." });
  } else {
    output("Commands: position, candidates, rescue [--dry-run] [--transport rest|mcp], audit, mcp-probe. Add --json for machine-readable output.");
  }
} finally {
  await mcp?.close();
}
