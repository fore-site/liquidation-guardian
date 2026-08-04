/**
 * Encrypted, Redis-backed credential + watch store.
 *
 * This is the shared state between the two faces of the server: the HTTP onboarding
 * (web form / Telegram Mini App) *writes* a record here, and the bot's watch loop
 * *reads* every record to check health factors and push alerts. Because both run in
 * one process (see server/serve.ts), they share this module directly.
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
    if (!this.redis.isOpen) await this.redis.connect();
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
    return raw ? (JSON.parse(raw) as GuardianRecord) : null;
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
    const ids = await this.redis.sMembers(ALL_SET);
    const out: GuardianRecord[] = [];
    for (const id of ids) {
      const rec = await this.getById(id);
      if (rec) out.push(rec);
      else await this.redis.sRem(ALL_SET, id); // prune a dangling index entry
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
