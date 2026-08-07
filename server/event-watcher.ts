/**
 * Event-driven watcher — the reactive "watches" trigger.
 *
 * Polls the Aave v3 Pool for the events that actually move a position's health
 * factor (`Supply`, `Repay`, `Borrow`, `Withdraw`, `LiquidationCall`,
 * `ReserveDataUpdated` for oracle price updates). On a hit it re-reads every
 * stored position's HF via KeeperHub and fires `onPositionEvent` for any that
 * dropped below threshold — so the Guardian reacts within ~1 block of an onchain
 * change instead of waiting for the next clock tick.
 *
 * This is the *primary* watcher — the fast reactive layer; the bot's watch loop
 * remains as the deterministic backup.
 *
 * Design notes:
 *  - Only topic0 (event signature) is matched — no ABI decoding needed. The
 *    authoritative per-wallet state comes from the KeeperHub re-read.
 *  - `ReserveDataUpdated` fires constantly (oracle heartbeats), so it's
 *    throttled: a price event only triggers a re-check if no other event has
 *    fired within `priceThrottleMs`.
 *  - Per-position re-reads are coalesced to `minReReadMs` so an event burst
 *    doesn't hammer KeeperHub's rate limit.
 *  - Topic hashes are keccak256 of the canonical Aave v3 Pool event signatures,
 *    cross-verified against live Sepolia logs (see docs/ARCHITECTURE.md).
 */
import { SEPOLIA_POOL } from "../src/agent/assets.js";
import { rpc, type RawLog } from "./rescues.js";
import type { GuardianRecord, GuardianStore } from "./store.js";

/** keccak256 of `Supply(address,address,address,uint256,uint16)`. */
const SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
/** keccak256 of `Repay(address,address,address,uint256,bool)`. */
const REPAY_TOPIC = "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051";
/** keccak256 of `Borrow(address,address,address,uint256,uint8,uint256,uint16)`. */
const BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0";
/** keccak256 of `Withdraw(address,address,address,uint256)`. */
const WITHDRAW_TOPIC = "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7";
/** keccak256 of `LiquidationCall(address,address,address,address,uint256,uint256,address,bool)`. */
const LIQUIDATION_TOPIC = "0x976383b0b539557b030cab089473f299bebca189233777f631eb31ec3dab397b";
/** keccak256 of `ReserveDataUpdated(address,uint256,uint256,uint256,uint256,uint256)`. */
const RESERVE_DATA_UPDATED_TOPIC = "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a";

/** Topics that indicate a user's position changed (any user). */
const USER_EVENT_TOPICS = [
  SUPPLY_TOPIC,
  REPAY_TOPIC,
  BORROW_TOPIC,
  WITHDRAW_TOPIC,
  LIQUIDATION_TOPIC,
];
/** The oracle-price-update topic, watched separately with throttling. */
const PRICE_EVENT_TOPIC = RESERVE_DATA_UPDATED_TOPIC;

/** Public-RPC eth_getLogs range cap — window under it. */
const MAX_RANGE = 49_000;
/** First-poll catch-up window: scan this many blocks back from head on start. */
const CATCHUP_BLOCKS = 200;

export interface EventWatcherOptions {
  /** Shared store of watched positions — re-read via `store.all()`. */
  store: GuardianStore;
  /** How often to poll the Pool for new events, ms. */
  pollMs?: number;
  /** Coalesce per-position re-reads to at most one per this window, ms. */
  minReReadMs?: number;
  /** Throttle ReserveDataUpdated-triggered re-checks to this window, ms. */
  priceThrottleMs?: number;
  /**
   * Called for a stored record whose HF dropped below threshold after an event.
   * The bot passes `runCheck(record)` — the same path its own loop uses.
   */
  onPositionEvent: (record: GuardianRecord) => Promise<void>;
}

/**
 * Poll the Pool's events and react. Does not decode who/what — a hit just means
 * "something happened on the Pool"; the callback re-reads the authoritative
 * per-wallet state via KeeperHub.
 */
export class EventWatcher {
  private readonly store: GuardianStore;
  private readonly pollMs: number;
  private readonly minReReadMs: number;
  private readonly priceThrottleMs: number;
  private readonly onPositionEvent: (record: GuardianRecord) => Promise<void>;

  private lastSeenBlock = 0;
  private lastPriceCheck = 0;
  private readonly lastReRead = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 2_000;
  private running = false;

  constructor(opts: EventWatcherOptions) {
    this.store = opts.store;
    this.pollMs = opts.pollMs ?? 5_000;
    this.minReReadMs = opts.minReReadMs ?? 15_000;
    this.priceThrottleMs = opts.priceThrottleMs ?? 30_000;
    this.onPositionEvent = opts.onPositionEvent;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Resume from the persisted cursor so a restart doesn't re-scan or miss
    // blocks. Fall back to a catch-up window when no cursor is saved yet.
    void this.store
      .getWatcherCursor()
      .then((c) => {
        this.lastSeenBlock = c ?? 0;
        console.log(
          `[event-watcher] watching ${USER_EVENT_TOPICS.length} user-event topics + price topic on ${SEPOLIA_POOL} (${this.pollMs}ms poll)` +
            (c ? ` — resuming from block ${c}` : " — no cursor, first-run catch-up"),
        );
      })
      .catch(() => undefined);
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
        this.backoffMs = this.pollMs;
      } catch (e) {
        // A failed poll must not kill the watcher — back off and retry.
        console.error(
          `[event-watcher] poll failed: ${e instanceof Error ? e.message : e} — backing off ${this.backoffMs}ms`,
        );
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      } finally {
        // Always sleep before the next poll — even when tick throws, the loop
        // keeps running (never a tight spin).
        await sleep(this.backoffMs);
      }
    }
  }

  /** True while a re-read run is in flight — coalesces overlapping runs. */
  private reReadInFlight = false;

  private async tick(): Promise<void> {
    // Discover the latest block once per tick.
    const latestRaw = await rpc("eth_blockNumber", []);
    const latest = typeof latestRaw === "string" ? parseInt(latestRaw, 16) : 0;
    if (latest <= this.lastSeenBlock) return;

    // First poll: catch up from a window behind head (events can sit a few
    // blocks behind the latest — head moves between eth_blockNumber and the
    // getLogs). Subsequent polls continue from lastSeenBlock + 1.
    const from = this.lastSeenBlock > 0 ? this.lastSeenBlock + 1 : Math.max(0, latest - CATCHUP_BLOCKS);
    const to = latest;

    const [userLogs, priceLogs] = await Promise.all([
      getPoolLogs(USER_EVENT_TOPICS, from, to),
      getPoolLogs([PRICE_EVENT_TOPIC], from, to),
    ]);

    const userHit = userLogs.length > 0;
    const priceHit = priceLogs.length > 0;
    const priceDue = Date.now() - this.lastPriceCheck >= this.priceThrottleMs;

    this.lastSeenBlock = latest;
    if (priceHit && priceDue) this.lastPriceCheck = Date.now();

    // Persist the cursor so a restart resumes from here (no gaps, no re-scan).
    await this.store.setWatcherCursor(latest);

    // Index any new Repay/Supply events into each wallet's Redis history so the
    // dashboard reads from Redis instead of scanning the chain every poll.
    if (userHit) await this.indexHistory(from, to);

    if ((userHit || (priceHit && priceDue)) && !this.reReadInFlight) {
      // Fire-and-forget: a slow runCheck (KeeperHub REST / LLM / broadcast) must
      // NOT pause the poll loop — the watcher stays reactive to new blocks while
      // the rescue runs concurrently. Overlapping runs are coalesced.
      this.reReadInFlight = true;
      void this.reReadAll().finally(() => {
        this.reReadInFlight = false;
      });
    }
  }

  /**
   * Decode Repay + Supply events in [from, to] and append them to each stored
   * wallet's Redis history (the dashboard's /api/rescues reads this instead of
   * scanning the chain). Best-effort: a decode/RPC failure just skips the window.
   */
  private async indexHistory(from: number, to: number): Promise<void> {
    const records = await this.store.all().catch(() => []);
    if (records.length === 0) return;
    const wallets = new Set(records.map((r) => r.wallet.toLowerCase()));
    const [repays, supplies] = await Promise.all([
      getPoolLogs([REPAY_TOPIC], from, to),
      getPoolLogs([SUPPLY_TOPIC], from, to),
    ]);
    const byWallet = new Map<string, Array<{ type: "repay" | "supply"; block: number }>>();
    for (const log of repays) {
      const user = topicToAddress(log.topics[2]);
      if (wallets.has(user)) push(byWallet, user, { type: "repay", block: parseInt(log.blockNumber, 16) });
    }
    for (const log of supplies) {
      const onBehalf = topicToAddress(log.topics[2]);
      if (wallets.has(onBehalf)) push(byWallet, onBehalf, { type: "supply", block: parseInt(log.blockNumber, 16) });
    }
    for (const [wallet, events] of byWallet) {
      await this.store.appendRescues(wallet, events).catch(() => undefined);
    }
  }

  /**
   * Re-read every stored position's HF via the callback. Coalesced: a record is
   * only re-read once per `minReReadMs`, so an event burst collapses into a
   * single check per position.
   */
  private async reReadAll(): Promise<void> {
    const now = Date.now();
    const records = await this.store.all();
    await Promise.all(
      records.map(async (record) => {
        const key = `${record.chainId}:${record.wallet.toLowerCase()}`;
        if (now - (this.lastReRead.get(key) ?? 0) < this.minReReadMs) return;
        this.lastReRead.set(key, now);
        try {
          await this.onPositionEvent(record);
        } catch (e) {
          console.error(
            `[event-watcher] onPositionEvent for ${record.wallet}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }),
    );
  }
}

/** Append to a map-of-arrays. */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Extract the 20-byte address from a 32-byte topic word. */
function topicToAddress(topic: string): string {
  return "0x" + topic.replace(/^0x/, "").slice(24).toLowerCase();
}

/**
 * Fetch logs for a set of topics across [from, to], windowed under the
 * public-RPC range cap. Best-effort per window.
 */
async function getPoolLogs(
  topics: string[],
  from: number,
  to: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let start = from; start <= to; start += MAX_RANGE + 1) {
    const end = Math.min(start + MAX_RANGE, to);
    try {
      const res = await rpc("eth_getLogs", [
        {
          address: SEPOLIA_POOL,
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
          topics: [topics],
        },
      ]);
      if (Array.isArray(res)) out.push(...(res as RawLog[]));
    } catch {
      // best-effort — skip a flaky window, keep the rest
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
