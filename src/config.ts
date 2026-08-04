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
  anthropicApiKey: string;
  /**
   * Optional Anthropic-compatible base URL (a router/proxy in front of the
   * models). Empty string ⇒ use the SDK default (api.anthropic.com).
   */
  anthropicBaseUrl: string;
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

export function loadConfig(opts: { requireAnthropic?: boolean } = {}): GuardianConfig {
  return {
    keeperHubApiKey: required("KEEPERHUB_API_KEY"),
    // The LLM key is only needed for the decision layer, not for read/first-tx scripts.
    anthropicApiKey: opts.requireAnthropic
      ? required("ANTHROPIC_API_KEY")
      : optional("ANTHROPIC_API_KEY", ""),
    // Router in front of Anthropic: accept BASE_URL (this project's name) or the
    // SDK's own ANTHROPIC_BASE_URL. Passed explicitly to the client below.
    anthropicBaseUrl: optional("BASE_URL", optional("ANTHROPIC_BASE_URL", "")),
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
