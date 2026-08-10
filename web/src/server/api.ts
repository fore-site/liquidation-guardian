/**
 * API server functions for the Guardian — the /api/* endpoints, ported to
 * TanStack Start server functions. The browser calls these directly (they run
 * server-side); the KeeperHub key never leaves the server.
 *
 * Cookie-setting endpoints (session POST/DELETE) return a `Response` so the
 * Set-Cookie header rides along; data endpoints return plain JSON.
 */
import { createServerFn } from "@tanstack/react-start";
import { COOKIE, readSid, sessionCookieHeader, sessionMiddleware } from "./session.js";
import { verifyInitData } from "@guardian/server/verifyInitData.js";
import { publicRecord, type GuardianRecord } from "@guardian/server/store.js";
import { getRescues } from "@guardian/server/rescues.js";

// Bootstrap + status are server-only (heavy deps: redis, rate-limiter, bot).
// Dynamic imports keep them out of the client bundle — the handlers run
// server-side, where the import resolves.
async function server() {
  return import("./bootstrap.server.js");
}
async function statusModule() {
  return import("./status.js");
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: now, value });
  return value;
}

function clampHf(n: number): number {
  if (!Number.isFinite(n)) return 1.5;
  return Math.min(5, Math.max(1.01, n));
}

/** 429 on limit, else false. Fails open on limiter errors (Redis down). */
async function limited(key: string, consume: (k: string) => Promise<{ ok: boolean; retryAfterSec: number }>): Promise<{ limited: boolean; retryAfterSec: number }> {
  const r = await consume(key);
  return { limited: !r.ok, retryAfterSec: r.retryAfterSec };
}

// ── GET /api/health ───────────────────────────────────────────────────────────

export const healthFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getContext, ensureBooted } = await server();
  await ensureBooted();
  const { store } = getContext();
  return { ok: true, redis: store.isReady, time: new Date().toISOString() };
});

// ── GET /api/session ──────────────────────────────────────────────────────────

export const getSessionFn = createServerFn({ method: "GET" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
  const { getContext, ensureBooted } = await server();
  await ensureBooted();
  const sid = (context as unknown as { sid?: string | null }).sid ?? null;
  const record = sid ? await getContext().store.getById(sid) : null;
  return record
    ? { authenticated: true, config: publicRecord(record) }
    : { authenticated: false };
});

// ── POST /api/session ─────────────────────────────────────────────────────────

export const openSessionFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) => d as {
    keeperHubApiKey: string;
    wallet: string;
    chainId?: string;
    hfThreshold?: number;
    hfTarget?: number;
    initData?: string;
  })
  .handler(async ({ data, context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store, cfg, bot, limiters } = getContext();

    // Strict rate limit by IP — protects onboarding from key-guessing / abuse.
    const ip = (context as unknown as { ip?: string }).ip ?? "unknown";
    const rl = await limited(ip, limiters.sessionPost);
    if (rl.limited) {
      return new Response(JSON.stringify({ error: `Rate limit exceeded. Retry in ${rl.retryAfterSec}s.` }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) },
      });
    }

    const keeperHubApiKey = String(data.keeperHubApiKey ?? "").trim();
    const wallet = String(data.wallet ?? "").trim();
    const chainId = String(data.chainId ?? "11155111").trim();
    const hfThreshold = clampHf(Number(data.hfThreshold ?? 1.5));
    const hfTarget = clampHf(Number(data.hfTarget ?? 2.0));
    const initData = typeof data.initData === "string" ? data.initData : "";

    if (!/^kh_[A-Za-z0-9]+$/.test(keeperHubApiKey)) {
      return json(400, { error: "That doesn't look like a KeeperHub API key (kh_…)." });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return json(400, { error: "Enter a valid wallet address (0x + 40 hex characters)." });
    }
    if (!(hfTarget > hfThreshold)) {
      return json(400, { error: "Restore target must be above the act-below threshold." });
    }

    let telegramUserId: number | undefined;
    let telegramChatId: number | undefined;
    let telegramUsername: string | undefined;
    if (initData) {
      if (!cfg.telegramBotToken) {
        return json(400, { error: "Telegram onboarding isn't enabled on this server." });
      }
      const verified = verifyInitData(initData, cfg.telegramBotToken);
      if (!verified) {
        return json(400, { error: "Couldn't verify your Telegram session. Reopen the app and retry." });
      }
      telegramUserId = verified.userId;
      telegramChatId = verified.userId; // private chat id == user id
      telegramUsername = verified.username;
    }

    // Prove the key + wallet actually work before we accept them.
    const probe = store.keeperHubFor({
      id: "probe",
      wallet,
      chainId,
      hfThreshold,
      hfTarget,
      encKey: store.encrypt(keeperHubApiKey),
      autoMode: false,
      createdAt: Date.now(),
    });
    try {
      await probe.readAavePosition(chainId, wallet);
    } catch {
      return json(400, {
        error: "Couldn't read that wallet with that key. Check the key, wallet, and network.",
      });
    }

    const record = await store.upsertByWallet({
      wallet,
      chainId,
      keeperHubApiKey,
      hfThreshold,
      hfTarget,
      telegramUserId,
      telegramChatId,
      telegramUsername,
    });
    cache.delete(`${record.id}:status`);

    if (telegramChatId != null && bot) void bot.notifyOnboarded(record);

    // Set the session cookie on the response.
    return new Response(JSON.stringify({ authenticated: true, config: publicRecord(record) }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(record.id) },
    });
  });

// ── DELETE /api/session ───────────────────────────────────────────────────────
// Logs THIS browser out: clears the session cookie + cached reads. The stored
// record (encrypted key + config) is KEPT, so the user can resume from another
// browser or via the resume flow — and the bot keeps watching a Telegram-bound
// record. The only way to delete the record is the bot's /stop or an explicit
// delete action.

export const closeSessionFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
  const { ensureBooted } = await server();
  await ensureBooted();
  const sid = (context as unknown as { sid?: string | null }).sid ?? null;
  if (sid) {
    for (const k of cache.keys()) if (k.startsWith(`${sid}:`)) cache.delete(k);
  }
  return new Response(JSON.stringify({ authenticated: false }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader("", true) },
  });
});

// ── POST /api/session/stop ────────────────────────────────────────────────────
// Permanently deletes the stored record (encrypted key + config + indexes) and
// clears the session cookie. Destructive — the user must onboard again to be
// watched. Mirrors the bot's /stop. (The bot keeps a Telegram-bound record's
// chat binding; this deletes the whole record, so the bot stops too.)

export const stopWatchingFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    if (sid) {
      await store.remove(sid).catch(() => undefined);
      for (const k of cache.keys()) if (k.startsWith(`${sid}:`)) cache.delete(k);
    }
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader("", true) },
    });
  });

// ── POST /api/session/telegram-link ───────────────────────────────────────────
// Create a one-time, 5-minute link code that authorizes binding THIS record to a
// Telegram chat. The code rides in a t.me deep link (`?start=link_<code>`); the
// bot consumes it and binds the sender's Telegram user to the record. Returns the
// code + bot username so the client can build the deep link.

export const getTelegramLinkFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store, bot } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    const record = sid ? await store.getById(sid) : null;
    if (!record) {
      return new Response(JSON.stringify({ error: "Not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const code = await store.createLinkCode(record.id);
    return { code, botUsername: bot?.username ?? null };
  });

// ── POST /api/session/telegram-unbind ──────────────────────────────────────────
// Unbind the record from Telegram (keeps the record; the bot stops alerting this
// chat). The dashboard keeps watching. Mirrors the bot's /logout.

export const unbindTelegramFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    if (!sid) {
      return new Response(JSON.stringify({ error: "Not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const record = await store.unbindTelegram(sid);
    cache.delete(`${sid}:status`);
    return record ? { authenticated: true, config: publicRecord(record) } : { authenticated: false };
  });

// ── POST /api/session/pause ───────────────────────────────────────────────────
// Pause or resume the agent for this record. While paused, both the scheduled
// watch loop and the event-driven watcher skip the position entirely.

export const setPausedFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) => d as { paused: boolean })
  .handler(async ({ data, context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    if (!sid) {
      return new Response(JSON.stringify({ error: "Not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const record = await store.setPaused(sid, data.paused === true);
    cache.delete(`${sid}:status`);
    if (record) void store.setDirty(sid).catch(() => undefined);
    return record ? { authenticated: true, config: publicRecord(record) } : { authenticated: false };
  });

// ── POST /api/session/thresholds ───────────────────────────────────────────────
// Update the act-below threshold and restore target live from the dashboard.

export const updateThresholdsFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) => d as { hfThreshold: number; hfTarget: number })
  .handler(async ({ data, context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    if (!sid) {
      return new Response(JSON.stringify({ error: "Not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const threshold = clampHf(Number(data.hfThreshold));
    const target = clampHf(Number(data.hfTarget));
    if (!(target > threshold)) {
      return new Response(JSON.stringify({ error: "Restore target must be above the act-below threshold." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const record = await store.updateConfig(sid, { hfThreshold: threshold, hfTarget: target });
    cache.delete(`${sid}:status`);
    if (record) void store.setDirty(sid).catch(() => undefined);
    return record ? { authenticated: true, config: publicRecord(record) } : { authenticated: false };
  });

// ── GET /api/status ───────────────────────────────────────────────────────────

export const getStatusFn = createServerFn({ method: "GET" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
  const { getContext, ensureBooted } = await server();
  await ensureBooted();
  const { store, limiters } = getContext();
  const sid = (context as unknown as { sid?: string | null }).sid ?? null;
  const record = sid ? await store.getById(sid) : null;
  if (!record) {
    return new Response(JSON.stringify({ error: "Not connected. Add your KeeperHub details first." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rl = await limited(record.id, limiters.reads);
  if (rl.limited) {
    return new Response(JSON.stringify({ error: `Rate limit exceeded. Retry in ${rl.retryAfterSec}s.` }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) },
    });
  }
  // Dirty flag → bypass the 10s cache so an autonomous rescue shows instantly.
  const dirty = await store.checkAndClearDirty(record.id);
  const { buildStatus } = await statusModule();
  const status = dirty ? await buildStatus(record) : await cached(`${record.id}:status`, () => buildStatus(record));
  void store.appendHfSnapshot(record.id, status.healthFactor).catch(() => undefined);
  return status;
});

// ── GET /api/rescues ──────────────────────────────────────────────────────────

export const getRescuesFn = createServerFn({ method: "GET" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
  const { getContext, ensureBooted } = await server();
  await ensureBooted();
  const { store, limiters } = getContext();
  const sid = (context as unknown as { sid?: string | null }).sid ?? null;
  const record = sid ? await store.getById(sid) : null;
  if (!record) {
    return new Response(JSON.stringify({ error: "Not connected. Add your KeeperHub details first." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rl = await limited(record.id, limiters.reads);
  if (rl.limited) {
    return new Response(JSON.stringify({ error: `Rate limit exceeded. Retry in ${rl.retryAfterSec}s.` }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) },
    });
  }
  return cached(`${record.id}:rescues`, () => getRescues(store, record.wallet));
});

// ── GET /api/hf-history ───────────────────────────────────────────────────────

export const getHfHistoryFn = createServerFn({ method: "GET" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store } = getContext();
    const sid = (context as unknown as { sid?: string | null }).sid ?? null;
    const record = sid ? await store.getById(sid) : null;
    if (!record) {
      return new Response(JSON.stringify({ error: "Not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return store.getHfSnapshots(record.id);
  });

// ── POST /api/session/resume ────────────────────────────────────────────────
// Re-issues the session cookie for a wallet that already onboarded (the record +
// encrypted key persist in the store), so returning users don't re-enter their
// KeeperHub key. Requires the wallet + chainId; optionally re-binds/verifies the
// Telegram initData when opened from the bot. 404 when no record exists — the UI
// falls back to full onboarding.

export const resumeSessionFn = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) => d as { wallet: string; chainId?: string; initData?: string })
  .handler(async ({ data, context }) => {
    const { getContext, ensureBooted } = await server();
    await ensureBooted();
    const { store, cfg, bot, limiters } = getContext();

    const ip = (context as unknown as { ip?: string }).ip ?? "unknown";
    const rl = await limited(ip, limiters.sessionPost);
    if (rl.limited) {
      return new Response(JSON.stringify({ error: `Rate limit exceeded. Retry in ${rl.retryAfterSec}s.` }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) },
      });
    }

    const wallet = String(data.wallet ?? "").trim();
    const chainId = String(data.chainId ?? "11155111").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return json(400, { error: "Enter a valid wallet address (0x + 40 hex characters)." });
    }

    const record = await store.getByWallet(wallet, chainId);
    if (!record) {
      return new Response(JSON.stringify({ error: "No stored position for that wallet — onboard first." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // If initData came in (Telegram), verify + (re)bind the record to that user.
    let boundChat: number | null = null;
    if (typeof data.initData === "string" && data.initData) {
      if (!cfg.telegramBotToken) {
        return json(400, { error: "Telegram onboarding isn't enabled on this server." });
      }
      const verified = verifyInitData(data.initData, cfg.telegramBotToken);
      if (!verified) {
        return json(400, { error: "Couldn't verify your Telegram session. Reopen the app and retry." });
      }
      if (record.telegramUserId !== verified.userId) {
        const rebound = await store.upsertByWallet({
          wallet: record.wallet,
          chainId: record.chainId,
          keeperHubApiKey: store.decrypt(record.encKey),
          hfThreshold: record.hfThreshold,
          hfTarget: record.hfTarget,
          telegramUserId: verified.userId,
          telegramChatId: verified.userId,
          telegramUsername: verified.username,
        });
        boundChat = verified.userId;
        if (bot) void bot.notifyOnboarded(rebound);
      }
    }

    cache.delete(`${record.id}:status`);
    void store.setDirty(record.id).catch(() => undefined);
    if (boundChat != null) void store.appendHfSnapshot(record.id, NaN).catch(() => undefined);

    return new Response(
      JSON.stringify({ authenticated: true, config: publicRecord(await store.getById(record.id) ?? record) }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(record.id) },
      },
    );
  });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export { COOKIE, readSid };
export type { GuardianRecord };
