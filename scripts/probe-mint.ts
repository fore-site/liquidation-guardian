import "../src/net.js";
import { loadConfig } from "../src/config.js";
import { KeeperHub } from "../src/keeperhub.js";
import { SEPOLIA_FAUCET, SEPOLIA_RESERVES, toBaseUnits } from "../src/agent/assets.js";

const LINK = SEPOLIA_RESERVES.LINK;
const cfg = loadConfig();
const kh = new KeeperHub({ apiKey: cfg.keeperHubApiKey });
const user = cfg.walletAddress;
const chainId = cfg.chainId;

const body = {
  chainId,
  contractAddress: SEPOLIA_FAUCET,
  functionName: "mint",
  functionArgs: JSON.stringify([LINK.address, user, toBaseUnits(LINK, 200)]),
};

console.log("=== real execute raw response ===");
try {
  const exec = await kh.executeAction("contract-call", body);
  console.log(JSON.stringify(exec, null, 2));
  // A broadcast that didn't reach a terminal state is worth flagging.
  const anyExec = exec as unknown as { executionId?: string };
  if (anyExec.executionId) {
    const final = await kh.waitForExecution(anyExec.executionId, { timeoutMs: 30_000 });
    console.log("final status:", JSON.stringify(final, null, 2));
  }
} catch (e) {
  console.log("threw:", e instanceof Error ? e.message : e);
  const anyE = e as { body?: unknown; status?: number };
  if (anyE.body) console.log("body:", JSON.stringify(anyE.body, null, 2));
  if (anyE.status) console.log("status:", anyE.status);
  process.exitCode = 1;
}
