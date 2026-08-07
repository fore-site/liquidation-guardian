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

/**
 * RPC provider list. The primary endpoint comes first; any extras (Alchemy,
 * QuickNode, Infura…) are appended via `SEPOLIA_RPC_URLS` (comma-separated). A
 * provider is demoted to the back of the list for `PROVIDER_COOLDOWN_MS` after a
 * failure, so traffic shifts to the healthy ones instead of hammering a downed
 * endpoint. The final (null) entry means "start over from the top" on retries.
 */
export const DEFAULT_RPC_URLS: (string | null)[] = [
  process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com",
  ...(process.env.SEPOLIA_RPC_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  null,
];
const PROVIDER_COOLDOWN_MS = 60_000;
/** Cap on sequential in-flight requests per provider (request pacing). */
const PROVIDER_MAX_INFLIGHT = 8;

// How far back to look. Sepolia is ~12s/block, so 250k blocks ≈ a month — plenty
// for a demo wallet.
const DEFAULT_LOOKBACK = 250_000;
// Public RPCs cap eth_getLogs at 50k blocks per call (publicnode: "exceed maximum
// block range: 50000"), so we window the lookback into chunks just under that.
const MAX_RANGE = 49_000;

/** Global HTTP fetch timeout — a hung provider must not stall the poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

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
  const lookback = Number(process.env.RESCUE_LOOKBACK_BLOCKS || DEFAULT_LOOKBACK);

  const latest = await rpc("eth_blockNumber", []);
  const latestBlock = typeof latest === "string" ? parseInt(latest, 16) : 0;
  const fromBlock = Math.max(0, latestBlock - lookback);
  const topicUser = padAddress(user);

  const [repays, supplies] = await Promise.all([
    getLogs(REPAY_TOPIC, topicUser, fromBlock, latestBlock),
    getLogs(SUPPLY_TOPIC, topicUser, fromBlock, latestBlock),
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
  topic0: string,
  topicUser: string,
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_RANGE + 1) {
    const end = Math.min(start + MAX_RANGE, toBlock);
    try {
      const res = await rpc("eth_getLogs", [
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

// ── Provider rotation + pacing ──────────────────────────────────────────────
interface ProviderState {
  url: string;
  /** ms timestamp when a failure makes this provider temporarily unusable. */
  cooldownUntil: number;
  /** in-flight requests (for the per-provider concurrency cap). */
  inflight: number;
}

const providerStates = new Map<string, ProviderState>(
  DEFAULT_RPC_URLS.filter((u): u is string => u !== null).map((u) => [
    u,
    { url: u, cooldownUntil: 0, inflight: 0 },
  ]),
);
let providerCursor = 0;
/** Sequential id for JSON-RPC requests — some providers reject duplicate ids. */
let rpcId = 0;

/** Effective provider list for a call: demoted providers are skipped while cooling down. */
function healthyProviders(): string[] {
  const now = Date.now();
  const list = [...providerStates.values()]
    .filter((p) => now >= p.cooldownUntil && p.inflight < PROVIDER_MAX_INFLIGHT)
    .map((p) => p.url);
  // Round-robin: rotate the cursor so a single busy provider isn't repeatedly first.
  if (list.length > 0) providerCursor = (providerCursor + 1) % list.length;
  return list;
}

/**
 * JSON-RPC POST with provider failover, per-provider pacing, and retries.
 *
 * `urls` is a rotation of endpoints ending with `null` ("wrap around"). On each
 * attempt the next available provider is tried; a failure (network, HTTP ≥400, or
 * an RPC-level error) puts that provider in a cooldown, and the next provider is
 * tried immediately. `null` means "we've been around once — retry the first
 * provider, then give up". Providers never run concurrently: a call always goes
 * to a single healthy provider, so pacing is implicit and no provider is
 * hammered by parallel retries.
 */
export async function rpc(
  method: string,
  params: unknown[],
  urls: (string | null)[] = DEFAULT_RPC_URLS,
  retries = 2,
): Promise<unknown> {
  let attempt = 0;
  while (attempt <= retries) {
    // Pick the next provider: normal round-robin while healthy, else the first
    // available healthy one.
    const healthy = healthyProviders();
    const base = urls[attempt % urls.length];
    const next = healthy.find((u) => u === base) ?? healthy[0];
    if (!next) {
      // All providers cooling down — wait for the shortest cooldown.
      const soonest = Math.min(
        ...[...providerStates.values()].map((p) => p.cooldownUntil),
        Date.now(),
      );
      await new Promise((r) => setTimeout(r, Math.max(0, soonest - Date.now()) + 50));
      continue;
    }

    const state = providerStates.get(next)!;
    state.inflight++;
    try {
      return await postRpc(next, method, params);
    } catch (err) {
      // Demote this provider until it recovers, then try the next one.
      state.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
      attempt++;
      if (attempt > retries) throw err;
      continue;
    } finally {
      state.inflight--;
    }
  }
  throw new Error("RPC: all providers failed");
}

/** Single POST to one provider with a global timeout. Throws on any failure. */
async function postRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
