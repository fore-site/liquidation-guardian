import "../src/net.js";
import { loadConfig } from "../src/config.js";
import { KeeperHubMcpClient } from "../src/keeperhub-mcp.js";

const cfg = loadConfig();
const client = new KeeperHubMcpClient({ apiKey: cfg.keeperHubApiKey, url: cfg.keeperHubMcpUrl });
try {
  const tools = await client.listTools();
  const workflowTools = tools.filter((tool) => /workflow|execution/i.test(tool));
  const docs = workflowTools.length > 0 ? await client.callTool("tools_documentation", {}) : undefined;
  console.log(JSON.stringify({ workflowTools, documentationAvailable: Boolean(docs), createWorkflowAvailable: workflowTools.includes("create_workflow"), validateWorkflowAvailable: workflowTools.includes("validate_workflow") }, null, 2));
} finally {
  await client.close();
}
