/**
 * Rescue history, read straight from the chain.
 *
 * The dashboard's "past rescues" list comes from Aave's own Pool events, not a
 * local log — so it's the same provider-free onchain truth we verify by hand in
 * docs/RESCUE_TX.md (an `eth_getLogs` for the Repay/Supply topics). No ABI library:
 * the two events we care about have a fixed layout we decode with slicing.
 *
 * Aave v3 events (indexed params become topics, the rest live in `data`):
 *   Repay(address indexed reserve, address indexed user, address indexed repayer,
 *         uint256 amount, bool useATokens)
 *     → topics: [sig, reserve, user, repayer] · data: [amount][useATokens]
 *   Supply(address indexed reserve, address user, address indexed onBehalfOf,
 *          uint256 amount, uint16 indexed referralCode)
 *     → topics: [sig, reserve, onBehalfOf, referralCode] · data: [user][amount]
 *
 * In both, the position owner we filter on sits at topic2 (Repay `user`,
 * Supply `onBehalfOf`), so one `eth_getLogs` per event with topic2 pinned to the
 * wallet finds exactly this user's actions.
 */
import { SEPOLIA_POOL, SEPOLIA_RESERVES, type ReserveInfo } from "../src/agent/assets.js";
import type { GuardianStore } from "./store.js";

const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
// How far back to look. Sepolia is ~12s/block, so 250k blocks ≈ a month — plenty
// for a demo wallet.
const DEFAULT_LOOKBACK = 250_000;
// Public RPCs cap eth_getLogs at 50k blocks per call (publicnode: "exceed maximum
// block range: 50000"), so we window the lookback into chunks just under that.
const MAX_RANGE = 49_000;

// keccak256 of the canonical event signatures (stable Aave v3 constants).
const REPAY_TOPIC = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";
const SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";

export interface RescueEvent {
  type: "repay" | "supply";
  asset: string;
  amountHuman: number;
  txHash: string;
  block: number;
  link: string;
}

/** Reverse map: lower-cased reserve address → reserve info (symbol, decimals). */
const RESERVE_BY_ADDRESS: Record<string, ReserveInfo> = Object.fromEntries(
  Object.values(SEPOLIA_RESERVES).map((r) => [r.address.toLowerCase(), r]),
);

/**
 * Read this user's Repay + Supply history, newest first. Served from the
 * Redis-backed history the event watcher indexes (fast, no RPC on every poll).
 * On first run (no cursor yet) it backfills the lookback window once and stores
 * the result. Best-effort: a flaky RPC returns an empty list rather than
 * breaking the dashboard.
 */
export async function getRescues(
  store: GuardianStore,
  user: string,
): Promise<RescueEvent[]> {
  // Fast path: history already indexed → read from Redis.
  const cursor = await store.getRescuesCursor(user);
  if (cursor != null) {
    const cached = await store.getRescues(user);
    return cached as RescueEvent[];
  }

  // Backfill path: first run for this wallet — scan the lookback window once.
  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim() || DEFAULT_RPC;
  const lookback = Number(process.env.RESCUE_LOOKBACK_BLOCKS || DEFAULT_LOOKBACK);

  const latest = await rpc(rpcUrl, "eth_blockNumber", []);
  const latestBlock = typeof latest === "string" ? parseInt(latest, 16) : 0;
  const fromBlock = Math.max(0, latestBlock - lookback);
  const topicUser = padAddress(user);

  const [repays, supplies] = await Promise.all([
    getLogs(rpcUrl, REPAY_TOPIC, topicUser, fromBlock, latestBlock),
    getLogs(rpcUrl, SUPPLY_TOPIC, topicUser, fromBlock, latestBlock),
  ]);

  const events: RescueEvent[] = [];
  for (const log of repays) {
    const e = decodeLog(log, "repay");
    if (e) events.push(e);
  }
  for (const log of supplies) {
    const e = decodeLog(log, "supply");
    if (e) events.push(e);
  }
  events.sort((a, b) => b.block - a.block);

  // Store the backfill + set the cursor so the watcher continues incrementally.
  await store.appendRescues(user, events).catch(() => undefined);
  await store.setRescuesCursor(user, latestBlock).catch(() => undefined);

  return events;
}

export interface RawLog {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

/**
 * Fetch this user's logs for one event topic across [fromBlock, toBlock], windowed
 * into ≤MAX_RANGE chunks to respect public-RPC range caps. Best-effort per chunk: a
 * failed window is skipped rather than breaking the whole history.
 */
async function getLogs(
  rpcUrl: string,
  topic0: string,
  topicUser: string,
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_RANGE + 1) {
    const end = Math.min(start + MAX_RANGE, toBlock);
    try {
      const res = await rpc(rpcUrl, "eth_getLogs", [
        {
          address: SEPOLIA_POOL,
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
          // [sig, reserve(any), user] — null wildcards the reserve topic.
          topics: [topic0, null, topicUser],
        },
      ]);
      if (Array.isArray(res)) out.push(...(res as RawLog[]));
    } catch {
      // best-effort — skip this window on an RPC hiccup, keep the rest
    }
  }
  return out;
}

/** Decode one log into a RescueEvent, or null if the reserve is unknown to us. */
function decodeLog(log: RawLog, type: "repay" | "supply"): RescueEvent | null {
  const reserveAddr = topicToAddress(log.topics[1]);
  const reserve = RESERVE_BY_ADDRESS[reserveAddr];
  if (!reserve) return null;

  // Repay data = [amount][useATokens]; Supply data = [user][amount].
  const data = log.data.replace(/^0x/, "");
  const word = (i: number): bigint => BigInt("0x" + (data.slice(i * 64, i * 64 + 64) || "0"));
  const amount = type === "repay" ? word(0) : word(1);

  const txHash = log.transactionHash;
  return {
    type,
    asset: reserve.symbol,
    amountHuman: Number(amount) / 10 ** reserve.decimals,
    txHash,
    block: parseInt(log.blockNumber, 16),
    link: `https://sepolia.etherscan.io/tx/${txHash}`,
  };
}

/** Minimal JSON-RPC POST. Throws on RPC-level errors. */
export async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

/** Left-pad a 20-byte address to a 32-byte topic. */
function padAddress(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Extract the 20-byte address from a 32-byte topic word. */
function topicToAddress(topic: string): string {
  return "0x" + topic.replace(/^0x/, "").slice(24).toLowerCase();
}
