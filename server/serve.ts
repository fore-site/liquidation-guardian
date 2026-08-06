/**
 * Guardian server: the hosted API + static UI + Telegram bot, in one process.
 *
 * Two faces share one encrypted store (server/store.ts):
 *   - **HTTP onboarding + dashboard** — the web form (or the Telegram Mini App) POSTs
 *     the user's own KeeperHub key + wallet + risk settings once. The key is validated,
 *     encrypted at rest (AES-256-GCM), and never returned to the browser.
 *   - **Telegram bot** (server/bot.ts) — when TELEGRAM_BOT_TOKEN is set, a long-poll +
 *     watch loop starts in this same process, reading the same store so it can push an
 *     alert the instant a stored position drops below threshold.
 *
 * Routes:
 *   POST   /api/session  → { keeperHubApiKey, wallet, chainId?, hfThreshold?, hfTarget?, initData? }
 *                          validate creds; if a valid Mini App initData is present, bind
 *                          the Telegram user + notify the chat; encrypt + persist; set cookie
 *   GET    /api/session  → { authenticated, config? }  (config never includes the key)
 *   DELETE /api/session  → clears the cookie (removes a web-only record; keeps a bot-bound one)
 *   GET    /api/status   → live health factor, position, sized rescue levers
 *   GET    /api/rescues  → past Repay/Supply txs, read from Aave Pool events onchain
 *   GET    /api/health   → liveness
 *   *                    → static files from web/dist (the Mini App + dashboard SPA)
 *
 * Run:  npm run dev:api   (needs Redis at REDIS_URL + GUARDIAN_MASTER_KEY)
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import OpenAI from "openai";
import { loadServerConfig } from "../src/config.js";
import { buildSnapshot, type LlmConfig } from "../src/agent/guardian.js";
import { computeCandidates, type AssetPosition, type RescueCandidate } from "../src/agent/decide.js";
import { getRescues } from "./rescues.js";
import { GuardianStore, publicRecord, type GuardianRecord } from "./store.js";
import { verifyInitData } from "./verifyInitData.js";
import { GuardianBot } from "./bot.js";

const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const WEB_DIST = join(process.cwd(), "web", "dist");

const cfg = loadServerConfig();
const store = new GuardianStore({ redisUrl: cfg.redisUrl, masterKeyHex: cfg.guardianMasterKey });
// Optional operator-owned LLM stack for the decision layer (shared across users):
// Gemini primary + optional NVIDIA NIM fallback, with a short per-attempt
// budget so the watch loop stays fast when a provider is slow.
const nvidiaKey = process.env.NVIDIA_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const llm: LlmConfig | null =
  geminiKey && !geminiKey.includes("your_")
    ? {
        primary: new OpenAI({
          apiKey: geminiKey,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        }),
        primaryModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 15000),
        ...(nvidiaKey && !nvidiaKey.includes("your_")
          ? {
              fallback: new OpenAI({
                apiKey: nvidiaKey,
                ...(process.env.BASE_URL && !process.env.BASE_URL.includes("your_")
                  ? { baseURL: process.env.BASE_URL }
                  : {}),
              }),
              fallbackModel: process.env.LLM_MODEL ?? "deepseek-ai/deepseek-v4-flash",
            }
          : {}),
      }
    : null;
let bot: GuardianBot | null = null;

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

/** Serialize an AssetPosition (bigint → string) for JSON. */
function assetDto(a: AssetPosition) {
  return {
    symbol: a.symbol,
    address: a.address,
    decimals: a.decimals,
    tokens: a.tokens.toString(),
    tokensHuman: Number(a.tokens) / 10 ** a.decimals,
    priceUsd: a.priceUsd ?? null,
  };
}

/** Serialize a sized rescue lever for JSON. */
function candidateDto(c: RescueCandidate) {
  return {
    action: c.action,
    asset: c.asset.symbol,
    amountUnits: c.amountUnits.toString(),
    amountHuman: c.amountHuman,
    reachesTarget: c.reachesTarget,
    available: c.available,
    note: c.note ?? null,
  };
}

async function buildStatus(record: GuardianRecord) {
  const kh = store.keeperHubFor(record);
  const position = await kh.readAavePosition(record.chainId, record.wallet);
  const hasDebt = Number.isFinite(position.healthFactor) && position.totalDebtUsd > 0;

  // Discover composition + size every lever, exactly as read-position / the guardian do.
  // (buildSnapshot fetches prices only for a side with ≥2 assets; LINK/LINK reads none.)
  const snapshot = hasDebt ? await buildSnapshot(kh, record.chainId, record.wallet, position) : null;
  const candidates =
    snapshot && position.healthFactor < record.hfTarget ? computeCandidates(snapshot, record.hfTarget) : [];

  return {
    wallet: record.wallet,
    chainId: record.chainId,
    hfThreshold: record.hfThreshold,
    hfTarget: record.hfTarget,
    autoMode: record.autoMode,
    healthFactor: Number.isFinite(position.healthFactor) ? position.healthFactor : null,
    totalCollateralUsd: position.totalCollateralUsd,
    totalDebtUsd: position.totalDebtUsd,
    availableBorrowsUsd: position.availableBorrowsUsd,
    liquidationThreshold: position.liquidationThreshold,
    debts: snapshot ? snapshot.debts.map(assetDto) : [],
    collaterals: snapshot ? snapshot.collaterals.map(assetDto) : [],
    candidates: candidates.map(candidateDto),
    updatedAt: new Date().toISOString(),
  };
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  // Reflect origin + allow credentials so the session cookie works cross-origin
  // (e.g. the Telegram Mini App served from a tunnel, or the Vite dev server).
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return end(res, 204, "");

  const url = (req.url ?? "/").split("?")[0];
  route(req, res, url).catch((err) => {
    // A malformed request is the client's fault — surface it. Anything else is an
    // upstream/internal failure; never surface internals (which could include the key).
    if (err instanceof HttpError) {
      return json(res, err.status, { error: err.message });
    }
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        c: "serve",
        msg: `route failed: ${req.method} ${url}`,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    json(res, 500, { error: "Upstream read failed. Check the API server logs." });
  });
});

async function route(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  // Public routes.
  if (url === "/api/health") {
    return json(res, 200, { ok: true, redis: store.isReady, time: new Date().toISOString() });
  }

  if (url === "/api/session" && req.method === "POST") return openSession(req, res);
  if (url === "/api/session" && req.method === "DELETE") return closeSession(req, res);
  if (url === "/api/session" && req.method === "GET") {
    const record = await getRecord(req);
    return json(
      res,
      200,
      record ? { authenticated: true, config: publicRecord(record) } : { authenticated: false },
    );
  }

  // Authenticated read routes.
  if (url === "/api/status" || url === "/api/rescues") {
    const record = await getRecord(req);
    if (!record) return json(res, 401, { error: "Not connected. Add your KeeperHub details first." });
    if (url === "/api/status") {
      return json(res, 200, await cached(`${record.id}:status`, () => buildStatus(record)));
    }
    return json(res, 200, await cached(`${record.id}:rescues`, () => getRescues(record.wallet)));
  }

  if (url.startsWith("/api/")) return json(res, 404, { error: "Not found" });

  // Everything else → static SPA (the Mini App + dashboard).
  if (req.method === "GET") return serveStatic(url, res);
  return json(res, 404, { error: "Not found" });
}

/** Validate the supplied credentials with one real read, then persist an encrypted record. */
async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const keeperHubApiKey = String(body.keeperHubApiKey ?? "").trim();
  const wallet = String(body.wallet ?? "").trim();
  const chainId = String(body.chainId ?? "11155111").trim();
  const hfThreshold = clampHf(Number(body.hfThreshold ?? 1.5));
  const hfTarget = clampHf(Number(body.hfTarget ?? 2.0));
  const initData = typeof body.initData === "string" ? body.initData : "";

  if (!/^kh_[A-Za-z0-9]+$/.test(keeperHubApiKey)) {
    return json(res, 400, { error: "That doesn't look like a KeeperHub API key (kh_…)." });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json(res, 400, { error: "Enter a valid wallet address (0x + 40 hex characters)." });
  }
  if (!(hfTarget > hfThreshold)) {
    return json(res, 400, { error: "Restore target must be above the act-below threshold." });
  }

  // If the request came from the Mini App, authenticate the Telegram user. A present
  // but invalid initData is a hard reject — we never bind a spoofed identity.
  let telegramUserId: number | undefined;
  let telegramChatId: number | undefined;
  let telegramUsername: string | undefined;
  if (initData) {
    if (!cfg.telegramBotToken) {
      return json(res, 400, { error: "Telegram onboarding isn't enabled on this server." });
    }
    const verified = verifyInitData(initData, cfg.telegramBotToken);
    if (!verified) {
      return json(res, 400, { error: "Couldn't verify your Telegram session. Reopen the app and retry." });
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
    return json(res, 400, {
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
  setSessionCookie(res, record.id);

  // Confirm in-chat if this was a verified Telegram onboarding.
  if (telegramChatId != null && bot) void bot.notifyOnboarded(record);

  json(res, 200, { authenticated: true, config: publicRecord(record) });
}

async function closeSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = sidOf(req);
  if (id) {
    const record = await store.getById(id);
    // A pure web session: forget the credential entirely. A Telegram-bound record
    // stays so the bot keeps watching — /stop in the bot removes that one.
    if (record && record.telegramUserId == null) await store.remove(id);
    for (const k of cache.keys()) if (k.startsWith(`${id}:`)) cache.delete(k);
  }
  clearSessionCookie(res);
  json(res, 200, { authenticated: false });
}

// ── session cookie helpers ────────────────────────────────────────────────────

const COOKIE = "guardian_sid";

function sidOf(req: IncomingMessage): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE && v) return v;
  }
  return null;
}

async function getRecord(req: IncomingMessage): Promise<GuardianRecord | null> {
  const id = sidOf(req);
  if (!id) return null;
  return store.getById(id);
}

function setSessionCookie(res: ServerResponse, id: string): void {
  const maxAge = 12 * 60 * 60; // 12h cookie; the record itself persists in the store.
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ── static file serving (web/dist) ─────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  // Resolve within WEB_DIST and refuse anything that escapes it (path traversal).
  // decodeURIComponent can throw on a malformed escape — treat it as a 400, not a 500.
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    return end(res, 400, "Bad request");
  }
  let filePath = join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) return end(res, 403, "Forbidden");

  let data = await readFile(filePath).catch(() => null);
  if (data === null) {
    // SPA fallback: unknown non-file route → index.html.
    filePath = join(WEB_DIST, "index.html");
    data = await readFile(filePath).catch(() => null);
    if (data === null) {
      return end(res, 404, "UI not built. Run `npm run build` in web/ (or use the Vite dev server).");
    }
  }
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(data);
}

// ── small utilities ───────────────────────────────────────────────────────────

/** Health factor is meaningless ≤ 1 (that's liquidation); cap the top for sane sliders. */
function clampHf(n: number): number {
  if (!Number.isFinite(n)) return 1.5;
  return Math.min(5, Math.max(1.01, n));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8_192) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

/** An HTTP error whose status we want to surface to the client (vs. a 500). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  end(res, status, JSON.stringify(body), "application/json");
}
function end(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

// ── boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await store.connect();
  console.log("Connected to Redis store.");

  if (cfg.telegramBotToken) {
    bot = new GuardianBot({
      store,
      botToken: cfg.telegramBotToken,
      llm,
      webAppUrl: cfg.webAppUrl,
      watchIntervalMs: cfg.watchIntervalMs,
    });
    await bot.start();
  } else {
    console.log("(No TELEGRAM_BOT_TOKEN — running as the HTTP dashboard only.)");
  }

  // Health-check route already reflects store readiness.
  server.listen(PORT, () => {
    console.log(`Guardian server on http://localhost:${PORT}`);
    console.log(`  API: POST/GET/DELETE /api/session · GET /api/status · /api/rescues · /api/health`);
    console.log(`  UI:  serving web/dist (build with \`npm run build --prefix web\`)`);
  });
}

main().catch((err) => {
  console.error("Server failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
