import "../src/net.js";
import { loadConfig } from "../src/config.js";
import { formatVerification, verifyDemoTransaction } from "../src/transaction-verifier.js";
import { resolveReserve } from "../src/agent/assets.js";

const args = process.argv.slice(2);
function value(name: string): string {
  const index = args.indexOf(name);
  const found = index >= 0 ? args[index + 1] : undefined;
  if (!found) throw new Error(`Missing ${name}.`);
  return found;
}

const cfg = loadConfig();
const tx = value("--tx");
const action = value("--action");
const asset = value("--asset");
const amount = value("--amount");
const reserve = resolveReserve(asset);
if (!reserve) throw new Error(`Unknown registered asset: ${asset}`);
if (action !== "repay" && action !== "supply") throw new Error("--action must be repay or supply.");
const amountUnits = BigInt(amount);
const result = await verifyDemoTransaction({ txHash: tx, expected: { action, asset: reserve.address, user: cfg.walletAddress, amountUnits } });
console.log(JSON.stringify(formatVerification(result), null, 2));
if (result.status !== "confirmed") process.exitCode = 1;
