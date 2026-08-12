/**
 * Isolated read-only Workflow Builder showcase.
 *
 * Demonstrates KeeperHub's hosted Workflow Builder surface through the MCP server
 * using the READ path only: `list_workflows` (optional project/tag filter) and
 * `get_workflow` to inspect a single workflow's node/edge definition.
 *
 * Safety: this script NEVER creates, updates, deletes, validates-with-side-effects,
 * or executes a workflow — nothing that could write or broadcast. It is a pure
 * viewer over the same MCP tools the builder UI uses.
 *
 * Run:  npm run workflow-showcase                (list workflows)
 *       npm run workflow-showcase -- --workflow <id>   (inspect one definition)
 *       npm run workflow-showcase -- --json       (machine-readable output)
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { loadConfig } from "../src/config.js";
import { KeeperHubMcpClient } from "../src/keeperhub-mcp.js";

const cfg = loadConfig();
const args = process.argv.slice(2);
const json = args.includes("--json");
const workflowArg = args.indexOf("--workflow");
const workflowId = workflowArg >= 0 ? args[workflowArg + 1] : undefined;

const READ_ONLY_TOOLS = ["list_workflows", "get_workflow"] as const;

interface WorkflowSummary {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  nodeCount?: number;
}

function summarize(item: Record<string, unknown>): WorkflowSummary {
  const nodes = Array.isArray(item.nodes) ? (item.nodes as Array<{ type?: string }>) : [];
  return {
    id: String(item.id ?? item.workflowId ?? ""),
    name: typeof item.name === "string" ? item.name : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    enabled: item.enabled === true,
    nodeCount: nodes.length,
  };
}

const client = new KeeperHubMcpClient({ apiKey: cfg.keeperHubApiKey, url: cfg.keeperHubMcpUrl });
try {
  const tools = await client.listTools();
  const missing = READ_ONLY_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length > 0) {
    console.error(`Workflow Builder read tools unavailable on this MCP endpoint: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else if (!json) {
    console.log(`Workflow Builder read surface available (list_workflows, get_workflow) via ${cfg.keeperHubMcpUrl}`);
  }

  const listed = await client.callTool("list_workflows", {});
  const items = Array.isArray(listed) ? (listed as Record<string, unknown>[]) : [];

  if (!json) {
    console.log(`\n${items.length === 0 ? "No workflows found." : `Workflows (${items.length}):`}`);
    for (const item of items) {
      const s = summarize(item);
      console.log(`\n• ${s.name ?? s.id}  [${s.id}]${s.enabled ? "  (enabled)" : ""}`);
      if (s.description) console.log(`  ${s.description.slice(0, 200)}${s.description.length > 200 ? "…" : ""}`);
      console.log(`  ${s.nodeCount ?? 0} node(s)`);
    }
  }

  if (workflowId) {
    const definition = await client.callTool("get_workflow", { workflowId });
    if (json) {
      console.log(JSON.stringify({ workflows: items.map(summarize), definition }, null, 2));
    } else {
      const s = summarize(definition as Record<string, unknown>);
      console.log(`\nWorkflow ${workflowId}: ${s.name ?? "(unnamed)"}`);
      console.log(JSON.stringify(definition, null, 2));
    }
  } else if (json) {
    console.log(JSON.stringify({ workflows: items.map(summarize) }, null, 2));
  }
} finally {
  await client.close();
}
