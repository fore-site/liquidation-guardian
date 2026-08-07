/**
 * Rate limiting — Redis-backed sliding window via rate-limiter-flexible.
 *
 * Uses the same Redis the app already holds (via GuardianStore.redisClient), so
 * rate-limit state survives restarts, shares the `guardian:` namespace, and is
 * multi-node ready. Per route class, each with its own limiter instance.
 *
 * `consume` is a plain async function (key → boolean allowed) so it works both
 * with the current node:http handlers and with TanStack Start / Hono middleware.
 */
import {
  RateLimiterRedis,
  type IRateLimiterRedisOptions,
} from "rate-limiter-flexible";
import type { GuardianStore } from "./store.js";

export interface RateLimitConfig {
  /** Max requests per window. */
  points: number;
  /** Window duration in seconds. */
  durationSec: number;
  /** Redis key prefix for this limiter (e.g. "guardian:rl:session"). */
  keyPrefix: string;
}

function limiterFor(
  store: GuardianStore,
  cfg: RateLimitConfig,
): RateLimiterRedis {
  const opts: IRateLimiterRedisOptions = {
    storeClient: store.redisClient as never, // rate-limiter-flexible expects an ioredis/node-redis client
    points: cfg.points,
    duration: cfg.durationSec,
    keyPrefix: cfg.keyPrefix,
  };
  return new RateLimiterRedis(opts);
}

/**
 * Build a middleware-style consume function for one route class.
 * Returns `{ ok, retryAfterSec }` — the caller turns `ok:false` into a 429.
 */
export function buildRateLimiter(
  store: GuardianStore,
  cfg: RateLimitConfig,
): (key: string) => Promise<{ ok: boolean; retryAfterSec: number }> {
  const limiter = limiterFor(store, cfg);
  return async (key: string) => {
    try {
      await limiter.consume(key);
      return { ok: true, retryAfterSec: 0 };
    } catch (err) {
      // rate-limiter-flexible throws when the limit is exceeded; the rejection
      // carries msBeforeNext. A Redis failure must NOT block traffic — fail open.
      const e = err as unknown as { msBeforeNext?: number };
      if (e && typeof e.msBeforeNext === "number") {
        return { ok: false, retryAfterSec: Math.ceil(e.msBeforeNext / 1000) };
      }
      return { ok: true, retryAfterSec: 0 }; // fail open on Redis errors
    }
  };
}

/** Convenience: the per-route-class limiters used by the API. */
export interface ApiLimiters {
  /** Unauthenticated session POST (onboarding) — strict, by IP. */
  sessionPost: ReturnType<typeof buildRateLimiter>;
  /** Authenticated status + rescues reads — per record. */
  reads: ReturnType<typeof buildRateLimiter>;
  /** PATCH session (config/auto changes) — strict, per record. */
  controls: ReturnType<typeof buildRateLimiter>;
  /** Per-record hourly rescue cap — bot auto-rescue safety valve. */
  rescuesPerHour: ReturnType<typeof buildRateLimiter>;
}

export function buildApiLimiters(store: GuardianStore): ApiLimiters {
  const n = (v: string, d: number): number => {
    const x = Number(process.env[v]);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    sessionPost: buildRateLimiter(store, {
      points: n("RATE_LIMIT_SESSION_POST", 10),
      durationSec: 60,
      keyPrefix: "guardian:rl:session",
    }),
    reads: buildRateLimiter(store, {
      points: n("RATE_LIMIT_READS", 60),
      durationSec: 60,
      keyPrefix: "guardian:rl:reads",
    }),
    controls: buildRateLimiter(store, {
      points: n("RATE_LIMIT_CONTROLS", 30),
      durationSec: 60,
      keyPrefix: "guardian:rl:controls",
    }),
    rescuesPerHour: buildRateLimiter(store, {
      points: n("RATE_LIMIT_RESCUES_HOUR", 5),
      durationSec: 3600,
      keyPrefix: "guardian:rl:rescue",
    }),
  };
}
