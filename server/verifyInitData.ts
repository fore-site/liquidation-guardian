/**
 * Verify a Telegram Mini App `initData` string — this is how we authenticate the
 * Telegram user who opened the onboarding webview WITHOUT trusting anything the
 * client claims about itself.
 *
 * The Mini App exposes `window.Telegram.WebApp.initData`: a URL-encoded query string
 * that Telegram signs with the bot token. The onboarding POST forwards it verbatim.
 * We recompute the signature server-side; only if it matches (and the payload is
 * fresh) do we trust the embedded `user.id` and bind the chat to the credential.
 *
 * Algorithm (Telegram "Validating data received via the Mini App"):
 *   dataCheckString = every `key=value` pair EXCEPT `hash`, sorted by key, joined "\n"
 *   secretKey       = HMAC_SHA256(key="WebAppData", data=botToken)
 *   valid           = HMAC_SHA256(key=secretKey, data=dataCheckString) === hash
 * plus an `auth_date` freshness check so a leaked initData can't be replayed forever.
 *
 * Pure node:crypto — no dependency, no network.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifiedTelegramUser {
  userId: number;
  username?: string;
  firstName?: string;
}

/** Max age of a signed initData payload we'll accept, in seconds (24h). */
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;

export function verifyInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSec?: number; now?: number } = {},
): VerifiedTelegramUser | null {
  if (!initData || !botToken) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;

  // Build the data-check string: all pairs except `hash`, sorted by key.
  const pairs: string[] = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time compare — both are fixed-length hex, so lengths always match.
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Freshness: reject stale payloads (replay protection).
  const authDate = Number(params.get("auth_date") ?? "0");
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const maxAge = opts.maxAgeSec ?? MAX_AUTH_AGE_SEC;
  if (!Number.isFinite(authDate) || authDate <= 0 || nowSec - authDate > maxAge) {
    return null;
  }

  // Signature is valid → trust the embedded user object.
  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw) as {
      id?: number;
      username?: string;
      first_name?: string;
    };
    if (typeof user.id !== "number") return null;
    return { userId: user.id, username: user.username, firstName: user.first_name };
  } catch {
    return null;
  }
}
