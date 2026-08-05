/**
 * Tiny structured logger — timestamps, levels, component context, and safe error
 * serialization. The one observability primitive used across the codebase so a
 * failure anywhere is identifiable by (component, level, message, timing).
 *
 * Levels are filtered by LOG_LEVEL (debug < info < warn < error). Default info.
 * Log lines are single-line JSON for greppability: `{"t":...,"level":...,"c":...}`.
 */
const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = LEVELS[String(process.env.LOG_LEVEL ?? "").toLowerCase()] ?? LEVELS.info;

function serialize(v: unknown): string {
  if (v instanceof Error) {
    return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ""}`;
  }
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: keyof typeof LEVELS, component: string, message: string, extra?: unknown): void {
  const rec = {
    t: new Date().toISOString(),
    level,
    c: component,
    msg: message,
  };
  if (extra !== undefined) {
    try {
      Object.assign(rec, typeof extra === "object" && extra !== null ? extra : { extra: serialize(extra) });
    } catch {
      (rec as Record<string, unknown>).extra = serialize(extra);
    }
  }
  const line = JSON.stringify(rec);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(component: string) {
  const log = (level: keyof typeof LEVELS, message: string, extra?: unknown): void => {
    if (LEVELS[level] < configured) return;
    emit(level, component, message, extra);
  };
  return {
    debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
    info: (msg: string, extra?: unknown) => log("info", msg, extra),
    warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
    error: (msg: string, extra?: unknown) => log("error", msg, extra),
    /** Time an async operation and log the duration + outcome. */
    timed: async <T>(name: string, fn: () => Promise<T>, extra?: unknown): Promise<T> => {
      const start = Date.now();
      try {
        const out = await fn();
        log("debug", `${name} ok`, { ...(extra as object), durationMs: Date.now() - start });
        return out;
      } catch (err) {
        log("warn", `${name} failed`, {
          ...(extra as object),
          durationMs: Date.now() - start,
          error: serialize(err),
        });
        throw err;
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
