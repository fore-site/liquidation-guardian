/**
 * Loads and validates configuration from environment (.env).
 */
import { config as loadEnv } from "dotenv";

loadEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.includes("your_") || v.includes("_here")) {
    throw new Error(
      `Missing env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && !v.includes("your_") ? v : fallback;
}

export interface GuardianConfig {
  keeperHubApiKey: string;
  /**
   * LLM API key — any OpenAI-compatible provider (the provider and model are
   * configured via env; the code is provider-agnostic).
   */
  llmApiKey: string;
  /** Base URL of the OpenAI-compatible API (e.g. a hosted router's /v1). */
  llmBaseUrl: string;
  /** Model id served by the base URL. */
  llmModel: string;
  /**
   * Per-attempt LLM timeout in ms. Kept short so the Guardian stays fast — if the
   * model doesn't answer in time we move on to the deterministic sizing.
   */
  llmTimeoutMs: number;
  chainId: string;
  walletAddress: string;
  /** Health factor below which the Guardian acts. */
  hfThreshold: number;
  /** Health factor the Guardian restores a position to. */
  hfTarget: number;
  /** Symbol of the borrowed (debt) asset to repay. */
  debtAsset: string;
  /** Symbol of the collateral asset to add more of. */
  collateralAsset: string;
  /**
   * Where the KeeperHub monitor workflow hands off when HF < threshold — the
   * Guardian's decision endpoint. Empty ⇒ the deploy script uses a placeholder
   * and warns. Not a secret.
   */
  guardianWebhookUrl: string;
  /** Cron for the monitor workflow's Schedule trigger (UTC). */
  scheduleCron: string;
  /** Telegram bot token from @BotFather. Empty ⇒ the bot + watch loop don't start. */
  telegramBotToken: string;
  /** Public HTTPS URL the Mini App is served from (registered with @BotFather). */
  webAppUrl: string;
  /** 32-byte hex master key (AES-256-GCM) for encrypting stored KeeperHub keys at rest. */
  guardianMasterKey: string;
  /** Redis connection URL for the persistent credential + watch store. */
  redisUrl: string;
  /** How often the bot's watch loop re-reads every stored position, ms. */
  watchIntervalMs: number;
}

export function loadConfig(opts: { requireLlm?: boolean } = {}): GuardianConfig {
  return {
    keeperHubApiKey: required("KEEPERHUB_API_KEY"),
    // The LLM key is only needed for the decision layer, not for read/first-tx scripts.
    llmApiKey: opts.requireLlm
      ? required("LLM_API_KEY")
      : optional("LLM_API_KEY", ""),
    // OpenAI-compatible base URL — required only when the LLM is in use.
    llmBaseUrl: opts.requireLlm
      ? required("LLM_BASE_URL")
      : optional("LLM_BASE_URL", ""),
    // Model id served by the base URL — from env, never hardcoded.
    llmModel: opts.requireLlm ? required("LLM_MODEL") : optional("LLM_MODEL", ""),
    // Short per-attempt budget so the Guardian stays fast and falls back quickly.
    llmTimeoutMs: Number(optional("LLM_TIMEOUT_MS", "15000")),
    chainId: optional("CHAIN_ID", "11155111"),
    walletAddress: required("WALLET_ADDRESS"),
    hfThreshold: Number(optional("HEALTH_FACTOR_THRESHOLD", "1.15")),
    hfTarget: Number(optional("HEALTH_FACTOR_TARGET", "1.5")),
    // On Sepolia only LINK is borrowable, so the demo position is LINK/LINK.
    debtAsset: optional("DEBT_ASSET", "LINK"),
    collateralAsset: optional("COLLATERAL_ASSET", "LINK"),
    guardianWebhookUrl: optional("GUARDIAN_WEBHOOK_URL", ""),
    scheduleCron: optional("SCHEDULE_CRON", "*/10 * * * *"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    webAppUrl: optional("WEBAPP_URL", ""),
    guardianMasterKey: optional("GUARDIAN_MASTER_KEY", ""),
    redisUrl: optional("REDIS_URL", "redis://localhost:6379"),
    watchIntervalMs: Number(optional("WATCH_INTERVAL_MS", "60000")),
  };
}

/**
 * Config for the multi-tenant server (dashboard API + Telegram bot). Unlike
 * {@link loadConfig} it needs NO single wallet or KeeperHub key — every user brings
 * their own through onboarding. It DOES need a master key (to encrypt those keys at
 * rest) and a Redis URL (the shared store). The Telegram bot is optional: without a
 * token the server runs as the read-only dashboard only.
 */
export interface ServerConfig {
  /** 32-byte hex AES-256-GCM master key for encrypting stored KeeperHub keys. */
  guardianMasterKey: string;
  /** Redis connection URL for the persistent credential + watch store. */
  redisUrl: string;
  /** Telegram bot token from @BotFather. Empty ⇒ bot + watch loop don't start. */
  telegramBotToken: string;
  /** Public HTTPS URL the Mini App is served from (registered with @BotFather). */
  webAppUrl: string;
  /** How often the watch loop re-reads every stored position, ms. */
  watchIntervalMs: number;
}

export function loadServerConfig(): ServerConfig {
  const masterKey = required("GUARDIAN_MASTER_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error(
      "GUARDIAN_MASTER_KEY must be 32 bytes as 64 hex chars. Generate one: openssl rand -hex 32",
    );
  }
  return {
    guardianMasterKey: masterKey,
    redisUrl: optional("REDIS_URL", "redis://localhost:6379"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN", ""),
    webAppUrl: optional("WEBAPP_URL", ""),
    watchIntervalMs: Number(optional("WATCH_INTERVAL_MS", "60000")),
  };
}
