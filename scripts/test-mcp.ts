import { KeeperHubMcpClient } from "../src/keeperhub-mcp.js";
import { auditEvent } from "../src/audit.js";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

let rejected = false;
try { new KeeperHubMcpClient({ apiKey: "bad", url: "https://app.keeperhub.com/mcp" }); } catch { rejected = true; }
assert(rejected, "invalid API key was accepted");
rejected = false;
try { new KeeperHubMcpClient({ apiKey: "kh_test", url: "http://localhost/mcp" }); } catch { rejected = true; }
assert(rejected, "insecure MCP URL was accepted");
const event = auditEvent({ runId: "test", phase: "decision", source: "mcp", chainId: "11155111", wallet: "0xabc", reasoning: "Bearer kh_secret" });
assert(!JSON.stringify(event).includes("kh_secret"), "MCP audit data leaked a credential");
console.log("MCP validation tests passed.");
