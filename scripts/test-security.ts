/**
 * Hard gate for the two security-critical primitives the Telegram face rests on:
 *
 *   1. Telegram Mini App `initData` verification (server/verifyInitData.ts) — the
 *      only thing standing between "a signed Telegram user opened our webview" and
 *      "someone POSTed a wallet address they don't control". We sign a payload the
 *      way Telegram does, assert it's accepted, then assert every tamper — flipped
 *      hash, wrong bot token, stale auth_date, missing user — is rejected.
 *
 *   2. Credential encryption at rest (server/store.ts) — a KeeperHub key is an
 *      org-wide bearer credential; Redis must only ever hold `{iv, tag, ct}`. We
 *      assert decrypt(encrypt(k)) === k, that a wrong master key can't decrypt, and
 *      that the serialized blob contains no plaintext `kh_...`.
 *
 * No network, no Redis connection — pure crypto. Exits non-zero on any failure so
 * it can gate CI / the build.
 *
 * Run:  npm run test-security
 */
import { createHmac, randomBytes } from "node:crypto";
import { verifyInitData } from "../server/verifyInitData.js";
import { GuardianStore } from "../server/store.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const mark = ok ? "✅" : "❌";
  console.log(`  ${mark} ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
}

// ── Helper: sign an initData string exactly the way Telegram does ───────────────
// dataCheckString = pairs except `hash`, sorted, "\n"-joined; secret = HMAC("WebAppData", token).
function signInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const BOT_TOKEN = "123456:DUMMY_TEST_TOKEN_do_not_use_in_prod";
const NOW = 1_700_000_000_000; // fixed clock so auth_date math is deterministic
const nowSec = Math.floor(NOW / 1000);

console.log("\ninitData verification (server/verifyInitData.ts):");
{
  const user = JSON.stringify({ id: 4242, username: "satoshi", first_name: "Sat" });
  const goodFields = {
    user,
    auth_date: String(nowSec - 60), // signed a minute ago
    query_id: "AAABBB",
  };
  const good = signInitData(goodFields, BOT_TOKEN);

  // 1. A correctly-signed, fresh payload is accepted and the user is trusted.
  const ok = verifyInitData(good, BOT_TOKEN, { now: NOW });
  check("accepts a correctly-signed, fresh payload", ok !== null);
  check("extracts the embedded user id", ok?.userId === 4242, `got ${ok?.userId}`);
  check("extracts the username", ok?.username === "satoshi", `got ${ok?.username}`);

  // 2. A flipped hash byte is rejected (signature mismatch).
  const tamperedHash = good.replace(/hash=([0-9a-f])/, (_m, c) =>
    `hash=${c === "0" ? "1" : "0"}`,
  );
  check(
    "rejects a tampered hash",
    verifyInitData(tamperedHash, BOT_TOKEN, { now: NOW }) === null,
  );

  // 3. A tampered *payload* (user swapped, old hash kept) is rejected.
  const forgedUser = new URLSearchParams(good);
  forgedUser.set("user", JSON.stringify({ id: 9999, username: "mallory" }));
  check(
    "rejects a swapped user with a stale signature",
    verifyInitData(forgedUser.toString(), BOT_TOKEN, { now: NOW }) === null,
  );

  // 4. The right payload under the WRONG bot token is rejected.
  check(
    "rejects a valid payload verified with the wrong bot token",
    verifyInitData(good, "999:OTHER_TOKEN", { now: NOW }) === null,
  );

  // 5. A stale auth_date (older than the freshness window) is rejected — replay guard.
  const staleFields = { ...goodFields, auth_date: String(nowSec - 25 * 60 * 60) };
  const stale = signInitData(staleFields, BOT_TOKEN); // correctly signed, just old
  check(
    "rejects a correctly-signed but stale (>24h) payload",
    verifyInitData(stale, BOT_TOKEN, { now: NOW }) === null,
  );
  // ...and the same stale payload passes with a generous maxAge, proving it's the
  // freshness check doing the rejecting, not a signature problem.
  check(
    "the stale payload is otherwise validly signed (accepted with a wide maxAge)",
    verifyInitData(stale, BOT_TOKEN, { now: NOW, maxAgeSec: 48 * 60 * 60 }) !== null,
  );

  // 6. Missing hash / missing user / empty inputs are all rejected.
  check("rejects empty initData", verifyInitData("", BOT_TOKEN, { now: NOW }) === null);
  check("rejects an empty bot token", verifyInitData(good, "", { now: NOW }) === null);
  const noUser = signInitData({ auth_date: String(nowSec - 60) }, BOT_TOKEN);
  check(
    "rejects a signed payload with no user field",
    verifyInitData(noUser, BOT_TOKEN, { now: NOW }) === null,
  );
}

console.log("\ncredential encryption at rest (server/store.ts):");
{
  const masterKeyHex = randomBytes(32).toString("hex");
  const store = new GuardianStore({ redisUrl: "redis://unused:6379", masterKeyHex });

  const key = "kh_live_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a";

  // 1. Round-trip: decrypt(encrypt(k)) === k.
  const enc = store.encrypt(key);
  check("decrypt(encrypt(key)) === key", store.decrypt(enc) === key);

  // 2. The serialized blob (what actually lands in Redis) leaks no plaintext.
  const blob = JSON.stringify(enc);
  check("stored blob contains no plaintext 'kh_'", !blob.includes("kh_"));
  check("stored blob contains no substring of the key", !blob.includes(key.slice(4, 24)));
  check("blob has the three GCM fields (iv, tag, ct)", !!(enc.iv && enc.tag && enc.ct));

  // 3. A fresh IV each call → same plaintext encrypts to different ciphertext.
  const enc2 = store.encrypt(key);
  check("re-encrypting reuses no IV (fresh nonce each time)", enc.iv !== enc2.iv);
  check("...and yields different ciphertext", enc.ct !== enc2.ct);

  // 4. A different master key cannot decrypt (GCM auth tag fails).
  const other = new GuardianStore({
    redisUrl: "redis://unused:6379",
    masterKeyHex: randomBytes(32).toString("hex"),
  });
  let wrongKeyRejected = false;
  try {
    other.decrypt(enc);
  } catch {
    wrongKeyRejected = true;
  }
  check("a wrong master key fails to decrypt (auth tag rejects)", wrongKeyRejected);

  // 5. A tampered ciphertext is rejected by the auth tag (integrity, not just secrecy).
  const flipped = { ...enc, ct: (enc.ct[0] === "0" ? "1" : "0") + enc.ct.slice(1) };
  let tamperRejected = false;
  try {
    store.decrypt(flipped);
  } catch {
    tamperRejected = true;
  }
  check("tampered ciphertext is rejected by the GCM auth tag", tamperRejected);

  // 6. The constructor guards master-key length.
  let badLenRejected = false;
  try {
    new GuardianStore({ redisUrl: "redis://unused:6379", masterKeyHex: "deadbeef" });
  } catch {
    badLenRejected = true;
  }
  check("constructor rejects a non-32-byte master key", badLenRejected);
}

console.log(
  failures === 0
    ? "\n✅ All security checks passed.\n"
    : `\n❌ ${failures} security check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
