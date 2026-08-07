/**
 * Shared server-side singletons + lazy boot for the TanStack Start app.
 *
 * The Guardian server logic (Redis store, KeeperHub clients, Telegram bot,
 * event watcher) lives here and is imported by the API server functions. The
 * bot + watcher are started lazily on first use so they boot exactly once,
 * regardless of which server fn or route triggers the first request.
 */
import "@tanstack/react-start/server-only";
import "dotenv/config";
import { loadServerConfig } from "@guardian/src/config.js";
import { GuardianStore } from "@guardian/server/store.js";
import { GuardianBot } from "@guardian/server/bot.js";
import { EventWatcher } from "@guardian/server/event-watcher.js";
import { buildApiLimiters, type ApiLimiters } from "@guardian/server/rate-limit.js";
import { loadServerLlm } from "./llm.js";
import type { LlmConfig } from "@guardian/src/agent/guardian.js";

let booted = false;
let bootPromise: Promise<void> | null = null;

export interface ServerContext {
  cfg: ReturnType<typeof loadServerConfig>;
  store: GuardianStore;
  llm: LlmConfig | null;
  bot: GuardianBot | null;
  limiters: ApiLimiters;
}

const context: ServerContext = {
  cfg: loadServerConfig(),
  store: new GuardianStore({
    redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
    masterKeyHex: process.env.GUARDIAN_MASTER_KEY || "",
  }),
  llm: null,
  bot: null,
  limiters: null as unknown as ApiLimiters,
};

/** Ensure the store is connected + bot/watcher started — exactly once. */
export function ensureBooted(): Promise<void> {
  if (booted) return Promise.resolve();
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    context.llm = loadServerLlm();
    context.limiters = buildApiLimiters(context.store);
    await context.store.connect();
    console.log("Connected to Redis store.");

    if (context.cfg.telegramBotToken) {
      context.bot = new GuardianBot({
        store: context.store,
        botToken: context.cfg.telegramBotToken,
        llm: context.llm,
        // The Mini App opens the dashboard route; the root is the landing.
        webAppUrl: context.cfg.webAppUrl
          ? `${context.cfg.webAppUrl.replace(/\/$/, "")}/app`
          : "",
        watchIntervalMs: context.cfg.watchIntervalMs,
      });
      await context.bot.start();
    } else {
      console.log("(No TELEGRAM_BOT_TOKEN — running as the HTTP dashboard only.)");
    }

    if (process.env.EVENT_WATCH_ENABLED !== "false" && context.bot) {
      const watcher = new EventWatcher({
        store: context.store,
        rpcUrl: process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia.publicnode.com",
        pollMs: Number(process.env.EVENT_POLL_MS || 5000),
        minReReadMs: Number(process.env.MIN_RE_READ_MS || 15000),
        priceThrottleMs: Number(process.env.PRICE_EVENT_THROTTLE_MS || 30000),
        onPositionEvent: (record) => context.bot!.runCheck(record),
      });
      watcher.start();
    } else {
      console.log("(Event watcher disabled — no bot, or EVENT_WATCH_ENABLED=false.)");
    }
    booted = true;
  })().catch((err) => {
    bootPromise = null; // allow a retry on next request
    console.error("[bootstrap] boot failed:", err instanceof Error ? err.message : err);
    throw err;
  });
  return bootPromise;
}

export function getContext(): ServerContext {
  return context;
}
