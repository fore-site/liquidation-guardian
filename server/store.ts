/**
 * Encrypted, Redis-backed credential + watch store.
 *
 * This is the shared state between the two faces of the server: the web onboarding
 * (TanStack Start app / Telegram Mini App) *writes* a record here, and the bot's watch loop
 * *reads* every record to check health factors and push alerts. Because both run in
 * one process (the TanStack Start server), they share this module directly.
 *
 * ## The security invariant
 *
 * A KeeperHub key is a bearer credential for a whole org. It is:
 *   - accepted only over HTTPS (onboarding POST), never through a Telegram message;
 *   - encrypted at rest with AES-256-GCM under a 32-byte master key from env
 *     (GUARDIAN_MASTER_KEY) — Redis only ever holds `{iv, tag, ct}`, never plaintext;
 *   - decrypted transiently, in memory, only to build a `KeeperHub` client, which is
 *     cached per record so we don't re-decrypt every watch tick.
 *
 * A dump of Redis therefore yields no usable keys without the master key, which lives
 * only in the process environment.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { KeeperHub } from "../src/keeperhub.js";

/** AES-256-GCM ciphertext blob, all hex. */
export interface EncryptedKey {
  iv: string;
  tag: string;
  ct: string;
}

/** One protected position. The KeeperHub key is only ever present here as `encKey`. */
export interface GuardianRecord {
  id: string;
  wallet: string;
  chainId: string;
  hfThreshold: number;
  hfTarget: number;
  encKey: EncryptedKey;
  /** Verified Telegram user id, if this record was onboarded / bound via the bot. */
  telegramUserId?: number;
  /** Chat to push alerts to (same as userId for private chats). */
  telegramChatId?: number;
  telegramUsername?: string;
  /** When true, the watch loop executes rescues autonomously and just notifies. */
  autoMode: boolean;
  createdAt: number;
  /** Last time we alerted/acted on this record, to de-dupe repeated ticks. */
  lastAlertAt?: number;
}

/** The record shape safe to hand to a browser or log — never includes the key. */
export function publicRecord(r: GuardianRecord) {
  return {
    wallet: r.wallet,
    chainId: r.chainId,
    hfThreshold: r.hfThreshold,
    hfTarget: r.hfTarget,
    autoMode: r.autoMode,
    telegramUsername: r.telegramUsername ?? null,
  };
}

const AES_ALGO = "aes-256-gcm";

// ── Redis key layout ──────────────────────────────────────────────────────────
const REC = (id: string) => `guardian:record:${id}`;
const TG_INDEX = (userId: number) => `guardian:tg:${userId}`;
const WALLET_INDEX = (wallet: string, chainId: string) =>
  `guardian:wallet:${chainId}:${wallet.toLowerCase()}`;
const ALL_SET = "guardian:all";
const RESCUES = (wallet: string) => `guardian:rescues:${wallet.toLowerCase()}`;
const RESCUES_CURSOR = (wallet: string) => `guardian:rescues-cursor:${wallet.toLowerCase()}`;
const WATCHER_CURSOR = "guardian:watcher-cursor";
const DIRTY = (id: string) => `guardian:dirty:${id}`;
const LINK_CODE = (code: string) => `guardian:link:${code.toLowerCase()}`;
const HF_SNAPSHOTS = (id: string) => `guardian:hf:${id}`;
/** Cap on stored decoded rescues per wallet (oldest dropped). */
const MAX_RESCUES = 100;
/** Cap on stored HF snapshots per record (oldest dropped). */
const MAX_HF_SNAPSHOTS = 200;

/**
 * The store. Construct once at boot with the server config, `await connect()`, then
 * share the instance between the HTTP handlers and the bot.
 */
export class GuardianStore {
  private readonly redis: RedisClientType;
  private readonly masterKey: Buffer;
  /** Cache decrypted KeeperHub clients by record id so we don't re-decrypt each tick. */
  private readonly clients = new Map<string, KeeperHub>();

  constructor(opts: { redisUrl: string; masterKeyHex: string }) {
    this.masterKey = Buffer.from(opts.masterKeyHex, "hex");
    if (this.masterKey.length !== 32) {
      throw new Error("GUARDIAN_MASTER_KEY must decode to exactly 32 bytes (64 hex chars).");
    }
    this.redis = createClient({ url: opts.redisUrl });
    this.redis.on("error", (err) => console.error("[redis]", err instanceof Error ? err.message : err));
  }

  async connect(): Promise<void> {
    if (this.redis.isOpen) return;
    try {
      await this.redis.connect();
    } catch (err) {
      // The redis client stays in a reconnectable state after a failed initial
      // connect; surface it loudly rather than crashing the process.
      console.error("[store] initial Redis connect failed:", err instanceof Error ? err.message : err);
      throw err;
    }
  }

  /** True if the underlying Redis socket is currently usable. */
  get isReady(): boolean {
    return this.redis.isOpen && this.redis.isReady;
  }

  /**
   * The shared Redis client — used by the rate limiter (Redis-backed
   * rate-limiter-flexible) so one connection holds records, cursors, flags, and
   * rate-limit counters.
   */
  get redisClient(): RedisClientType {
    return this.redis;
  }

  async close(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  // ── AES-256-GCM ───────────────────────────────────────────────────────────
  encrypt(plain: string): EncryptedKey {
    const iv = randomBytes(12); // 96-bit nonce, the GCM standard
    const cipher = createCipheriv(AES_ALGO, this.masterKey, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("hex"), tag: tag.toString("hex"), ct: ct.toString("hex") };
  }

  decrypt(enc: EncryptedKey): string {
    const decipher = createDecipheriv(AES_ALGO, this.masterKey, Buffer.from(enc.iv, "hex"));
    decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(enc.ct, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  }

  // ── Record CRUD + indexes ───────────────────────────────────────────────────

  /**
   * Insert or update the record for a (wallet, chainId), encrypting the fresh key.
   * Keyed on wallet so re-onboarding the same wallet updates in place (and rebinds
   * Telegram) rather than orphaning a record. Returns the stored record.
   */
  async upsertByWallet(input: {
    wallet: string;
    chainId: string;
    keeperHubApiKey: string;
    hfThreshold: number;
    hfTarget: number;
    telegramUserId?: number;
    telegramChatId?: number;
    telegramUsername?: string;
  }): Promise<GuardianRecord> {
    const existing = await this.getByWallet(input.wallet, input.chainId);
    const id = existing?.id ?? randomUUID();
    const record: GuardianRecord = {
      id,
      wallet: input.wallet,
      chainId: input.chainId,
      hfThreshold: input.hfThreshold,
      hfTarget: input.hfTarget,
      encKey: this.encrypt(input.keeperHubApiKey),
      // Preserve prior Telegram binding + autoMode unless this onboarding sets them.
      telegramUserId: input.telegramUserId ?? existing?.telegramUserId,
      telegramChatId: input.telegramChatId ?? existing?.telegramChatId,
      telegramUsername: input.telegramUsername ?? existing?.telegramUsername,
      autoMode: existing?.autoMode ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
      lastAlertAt: existing?.lastAlertAt,
    };
    await this.save(record);
    // The key changed → drop any cached client so the next use decrypts fresh.
    this.clients.delete(id);
    return record;
  }

  /** Persist a record + refresh its indexes. */
  async save(record: GuardianRecord): Promise<void> {
    await this.redis.set(REC(record.id), JSON.stringify(record));
    await this.redis.sAdd(ALL_SET, record.id);
    await this.redis.set(WALLET_INDEX(record.wallet, record.chainId), record.id);
    if (record.telegramUserId != null) {
      await this.redis.set(TG_INDEX(record.telegramUserId), record.id);
    }
  }

  async getById(id: string): Promise<GuardianRecord | null> {
    const raw = await this.redis.get(REC(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GuardianRecord;
    } catch {
      // Corrupt/malformed record in Redis: log it and treat as missing so a single
      // bad blob can't crash the watch loop or an API read.
      console.error(`[store] corrupt record ${id} — skipping (${raw.slice(0, 80)}…)`);
      return null;
    }
  }

  async getByWallet(wallet: string, chainId: string): Promise<GuardianRecord | null> {
    const id = await this.redis.get(WALLET_INDEX(wallet, chainId));
    return id ? this.getById(id) : null;
  }

  async getByTelegramUser(userId: number): Promise<GuardianRecord | null> {
    const id = await this.redis.get(TG_INDEX(userId));
    return id ? this.getById(id) : null;
  }

  /** Every stored record — the watch loop iterates this each tick. */
  async all(): Promise<GuardianRecord[]> {
    let ids: string[];
    try {
      ids = await this.redis.sMembers(ALL_SET);
    } catch (err) {
      // Redis is down: the watch loop can't know what to watch. Return empty so the
      // loop survives and retries next tick instead of crashing the process.
      console.error("[store] all() failed (Redis down?):", err instanceof Error ? err.message : err);
      return [];
    }
    const out: GuardianRecord[] = [];
    for (const id of ids) {
      const rec = await this.getById(id).catch(() => null);
      if (rec) out.push(rec);
      else {
        await this.redis.sRem(ALL_SET, id).catch(() => undefined); // prune a dangling index entry
      }
    }
    return out;
  }

  /** Remove a record and all its indexes (used by /stop). */
  async remove(id: string): Promise<void> {
    const rec = await this.getById(id);
    if (!rec) return;
    await this.redis.del(REC(id));
    await this.redis.sRem(ALL_SET, id);
    await this.redis.del(WALLET_INDEX(rec.wallet, rec.chainId));
    if (rec.telegramUserId != null) await this.redis.del(TG_INDEX(rec.telegramUserId));
    this.clients.delete(id);
  }

  /** Convenience mutators the bot uses; each re-saves + returns the updated record. */
  async setAutoMode(id: string, autoMode: boolean): Promise<GuardianRecord | null> {
    const rec = await this.getById(id);
    if (!rec) return null;
    rec.autoMode = autoMode;
    await this.save(rec);
    return rec;
  }

  async markAlerted(id: string, at = Date.now()): Promise<void> {
    const rec = await this.getById(id);
    if (!rec) return;
    rec.lastAlertAt = at;
    await this.save(rec);
  }

  /** Update a record's config (threshold/target). Validates target > threshold. */
  async updateConfig(
    id: string,
    patch: { hfThreshold?: number; hfTarget?: number },
  ): Promise<GuardianRecord | null> {
    const rec = await this.getById(id);
    if (!rec) return null;
    const threshold = patch.hfThreshold ?? rec.hfThreshold;
    const target = patch.hfTarget ?? rec.hfTarget;
    if (!(target > threshold)) return null;
    rec.hfThreshold = threshold;
    rec.hfTarget = target;
    await this.save(rec);
    return rec;
  }

  // ── Cursor + history (Redis, not in-memory) ────────────────────────────────

  /** Last block the rescue-history indexer scanned for this wallet, or null. */
  async getRescuesCursor(wallet: string): Promise<number | null> {
    const raw = await this.redis.get(RESCUES_CURSOR(wallet)).catch(() => null);
    return raw ? Number(raw) : null;
  }

  async setRescuesCursor(wallet: string, block: number): Promise<void> {
    await this.redis.set(RESCUES_CURSOR(wallet), String(block)).catch(() => undefined);
  }

  /** Decoded rescue history for a wallet, newest first. */
  async getRescues(wallet: string): Promise<unknown[]> {
    const raw = await this.redis.lRange(RESCUES(wallet), 0, -1).catch(() => []);
    const out: unknown[] = [];
    for (const item of raw) {
      try {
        out.push(JSON.parse(item));
      } catch {
        /* skip a corrupt entry */
      }
    }
    return out.reverse(); // Redis list is oldest-first; return newest-first
  }

  /** Append decoded rescues (newest first) to the wallet's capped history list. */
  async appendRescues(wallet: string, events: unknown[]): Promise<void> {
    if (events.length === 0) return;
    // Prepend newest-first so the Redis list stays oldest-first; then trim.
    for (const e of [...events].reverse()) {
      await this.redis.lPush(RESCUES(wallet), JSON.stringify(e)).catch(() => undefined);
    }
    await this.redis.lTrim(RESCUES(wallet), 0, MAX_RESCUES - 1).catch(() => undefined);
  }

  /** Last block the event watcher processed (global), or null. */
  async getWatcherCursor(): Promise<number | null> {
    const raw = await this.redis.get(WATCHER_CURSOR).catch(() => null);
    return raw ? Number(raw) : null;
  }

  async setWatcherCursor(block: number): Promise<void> {
    await this.redis.set(WATCHER_CURSOR, String(block)).catch(() => undefined);
  }

  // ── Dirty flag (cache invalidation) ────────────────────────────────────────

  /** Mark a record's status cache as stale (set by the rescue path). */
  async setDirty(id: string): Promise<void> {
    await this.redis.set(DIRTY(id), "1", { EX: 300 }).catch(() => undefined);
  }

  /** True if the dirty flag is set; clears it. Returns whether it was set. */
  async checkAndClearDirty(id: string): Promise<boolean> {
    const was = await this.redis.del(DIRTY(id)).catch(() => 0);
    return was > 0;
  }

  // ── Telegram link codes ─────────────────────────────────────────────────────

  /** Create a one-time, 5-minute link code → record id. Returns the code. */
  async createLinkCode(recordId: string): Promise<string> {
    const code = randomBytes(4).toString("hex"); // 8 hex chars
    await this.redis.set(LINK_CODE(code), recordId, { EX: 300 }).catch(() => undefined);
    return code;
  }

  /** Resolve a link code to a record id (consumes it). */
  async consumeLinkCode(code: string): Promise<string | null> {
    const id = await this.redis.getDel(LINK_CODE(code)).catch(() => null);
    return id ?? null;
  }

  // ── HF snapshots (for the dashboard chart) ──────────────────────────────────

  /** Append an HF reading to the record's capped time series. */
  async appendHfSnapshot(id: string, hf: number | null, at = Date.now()): Promise<void> {
    const pt = JSON.stringify({ t: at, hf });
    await this.redis.lPush(HF_SNAPSHOTS(id), pt).catch(() => undefined);
    await this.redis.lTrim(HF_SNAPSHOTS(id), 0, MAX_HF_SNAPSHOTS - 1).catch(() => undefined);
  }

  /** Recent HF readings, oldest-first (for the dashboard chart). */
  async getHfSnapshots(id: string): Promise<Array<{ t: number; hf: number | null }>> {
    const raw = await this.redis.lRange(HF_SNAPSHOTS(id), 0, -1).catch(() => []);
    const out: Array<{ t: number; hf: number | null }> = [];
    for (const item of raw) {
      try {
        out.push(JSON.parse(item));
      } catch {
        /* skip a corrupt entry */
      }
    }
    return out.reverse(); // oldest-first
  }

  /**
   * A KeeperHub client for this record, decrypting the key on first use and caching
   * the client. The plaintext key exists only inside this call and inside the client
   * instance — never returned, never persisted.
   */
  keeperHubFor(record: GuardianRecord): KeeperHub {
    const hit = this.clients.get(record.id);
    if (hit) return hit;
    const client = new KeeperHub({ apiKey: this.decrypt(record.encKey) });
    this.clients.set(record.id, client);
    return client;
  }
}
