/**
 * Rescue-lock semantics against REAL Redis (network required).
 *
 * Connects a GuardianStore to the configured REDIS_URL and exercises the exact
 * primitives the bot uses (`acquireRescueLock` / `releaseRescueLock`):
 *   - NX hold: a second acquirer is refused while the lock is held;
 *   - owner-checked release: a non-owner cannot release someone else's lock;
 *   - TTL expiry: a lock auto-expires after its TTL;
 *   - scoping: (chain, wallet) keying — a different chain is independent.
 *
 * If Redis is unreachable it prints how to start it and exits 0 (skip), so the
 * script stays safe to run ad hoc — the assertions are a hard gate only when
 * Redis is actually up.
 *
 * Run:  npm run test-rescue-lock-redis
 */
import { loadConfig } from "../src/config.js";
import { GuardianStore } from "../server/store.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cfg = loadConfig();
const store = new GuardianStore({ redisUrl: cfg.redisUrl, masterKeyHex: cfg.guardianMasterKey });

try {
  await store.connect();
} catch (err) {
  console.error(
    `Cannot reach Redis at ${cfg.redisUrl} (${err instanceof Error ? err.message : err}).\n` +
      `Start it and retry:  docker compose up -d redis   (or run a local redis-server).`,
  );
  process.exit(0); // soft skip — this gate needs a real Redis
}

// Throwaway keys — never touches real watch records or rescue keys.
const CHAIN = "11155111";
const OTHER_CHAIN = "84532";
const WALLET = "0xbeef00000000000000000000000000000000dead";
const ownerA = `test-a:${Date.now()}`;
const ownerB = `test-b:${Date.now()}`;
const TTL_MS = 250;

try {
  // 1. NX hold: first acquire wins, second is refused.
  const first = await store.acquireRescueLock(CHAIN, WALLET, ownerA);
  assert(first, "first acquire should succeed");
  const second = await store.acquireRescueLock(CHAIN, WALLET, ownerB);
  assert(!second, "second acquire while held should be refused");
  console.log("  ✅ NX hold: concurrent acquirer refused");

  // 2. Owner-checked release: a non-owner release must NOT free the lock.
  await store.releaseRescueLock(CHAIN, WALLET, ownerB);
  const stillHeld = !(await store.acquireRescueLock(CHAIN, WALLET, ownerB));
  assert(stillHeld, "release by a non-owner must not free the lock");
  console.log("  ✅ owner-checked release: wrong owner cannot release");

  // 3. Correct owner release frees the lock.
  await store.releaseRescueLock(CHAIN, WALLET, ownerA);
  const reacquired = await store.acquireRescueLock(CHAIN, WALLET, ownerB);
  assert(reacquired, "lock should be acquirable after the owner releases");
  await store.releaseRescueLock(CHAIN, WALLET, ownerB);
  console.log("  ✅ correct owner release frees the lock");

  // 4. TTL expiry: a lock auto-expires after its TTL.
  const shortTtl = await store.acquireRescueLock(CHAIN, WALLET, ownerA, TTL_MS);
  assert(shortTtl, "short-TTL acquire should succeed");
  await new Promise((r) => setTimeout(r, TTL_MS * 3));
  const afterExpiry = await store.acquireRescueLock(CHAIN, WALLET, ownerB);
  assert(afterExpiry, "lock must auto-expire after its TTL");
  await store.releaseRescueLock(CHAIN, WALLET, ownerB);
  console.log("  ✅ TTL expiry: lock auto-expires");

  // 5. Scoping: same wallet on a different chain is an independent lock.
  const otherChain = await store.acquireRescueLock(OTHER_CHAIN, WALLET, ownerA);
  assert(otherChain, "a lock on another chain must not block this chain");
  const sameChain = await store.acquireRescueLock(CHAIN, WALLET, ownerB);
  assert(sameChain, "a lock on another chain must not leak into this chain");
  await store.releaseRescueLock(OTHER_CHAIN, WALLET, ownerA);
  await store.releaseRescueLock(CHAIN, WALLET, ownerB);
  console.log("  ✅ per-(chain, wallet) scoping");

  console.log("\nRedis rescue-lock tests passed.");
} finally {
  // Defensive cleanup: drop any leftover test lock keys.
  await store.releaseRescueLock(CHAIN, WALLET, ownerA);
  await store.releaseRescueLock(CHAIN, WALLET, ownerB);
  await store.releaseRescueLock(OTHER_CHAIN, WALLET, ownerA);
  await store.close().catch(() => undefined);
}
