import "../src/net.js";
import { loadConfig } from "../src/config.js";
import { KeeperHubMcpClient } from "../src/keeperhub-mcp.js";

const cfg = loadConfig();
const client = new KeeperHubMcpClient({ apiKey: cfg.keeperHubApiKey, url: cfg.keeperHubMcpUrl });
try {
  const tools = await client.listTools();
  const actions = tools.includes("search_protocol_actions") ? await client.searchProtocolActions("repay") : undefined;
  console.log(JSON.stringify({ transport: "mcp", endpoint: cfg.keeperHubMcpUrl, tools: tools.filter((tool) => /aave|protocol|execution|action|documentation/i.test(tool)), protocolLookup: actions ? "ok" : "skipped" }, null, 2));
} finally {
  await client.close();
}
