/**
 * Chainlink USD price source — used ONLY when one side of a position holds two or
 * more assets, so the per-asset price no longer cancels out of the health-factor
 * algebra (see src/agent/decide.ts for why a single-asset side needs no price).
 *
 * Design note (a real Sepolia friction, see docs/TEARDOWN.md F10): KeeperHub's
 * *named* Chainlink actions (`chainlink/link-usd-latest-round-data`, …) are NOT all
 * deployed on Sepolia — only `eth-usd` and `btc-usd` resolve; `link-usd`/`usdc-usd`
 * fail with "contract … is not deployed on chain 11155111". So we use the GENERIC
 * `chainlink/latest-answer` action with an explicit feed address instead — one code
 * path, portable across chains, no per-feed deployment gaps. Every address below was
 * confirmed to return a live answer on Sepolia during the build.
 *
 * An asset with no known feed returns `null`; the multi-asset path treats it as
 * unpriceable and the agent avoids acting on that side (logged honestly, never
 * guessed). USD feeds report 8 decimals; we read `chainlink/decimals` once per feed
 * and cache it rather than assume.
 */
import type { KeeperHub } from "../keeperhub.js";

/**
 * Symbol → Chainlink USD aggregator address on Ethereum Sepolia (11155111).
 * These are the canonical Chainlink Data Feed proxies; each was verified live
 * (latest-answer returned a sane USD value) during the build. WETH prices off the
 * ETH/USD feed and WBTC off BTC/USD — wrapped tokens track the underlying.
 */
export const SEPOLIA_PRICE_FEEDS: Record<string, string> = {
  WETH: "0x694AA1769357215DE4FAC081bf1f309aDC325306", // ETH/USD
  WBTC: "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43", // BTC/USD
  LINK: "0xc59E3633BAAC79493d908e63626716e204A45EdF", // LINK/USD
  USDC: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E", // USDC/USD
  DAI: "0x14866185B1962B63C3Ea9E03Bc1da838bab34C19", // DAI/USD
  // No live Sepolia USD feed found for USDT / GHO / AAVE / EURS → readPriceUsd → null.
};

/** Cache of feed address → decimals, so we read `chainlink/decimals` at most once. */
const decimalsCache = new Map<string, number>();

/**
 * Read the USD price of `symbol` from its Chainlink feed. Returns a float (e.g.
 * 1860.12), or `null` if we have no feed for the asset or the read fails — callers
 * must treat `null` as "unpriceable, don't act on this side".
 */
export async function readPriceUsd(
  kh: KeeperHub,
  chainId: string,
  symbol: string,
): Promise<number | null> {
  const feed = SEPOLIA_PRICE_FEEDS[symbol.trim().toUpperCase()];
  if (!feed) return null;

  try {
    const answerRes = await kh.executeAction<string>("chainlink/latest-answer", {
      chainId,
      contractAddress: feed,
    });
    if (!answerRes.success || answerRes.result == null) return null;

    const rawAnswer = BigInt(answerRes.result);
    if (rawAnswer <= 0n) return null; // Chainlink uses <=0 for a stale/invalid round.

    const decimals = await feedDecimals(kh, chainId, feed);
    return Number(rawAnswer) / 10 ** decimals;
  } catch {
    // A price read must never crash the guardian; unpriceable is a safe "skip".
    return null;
  }
}

/** Read (and cache) a feed's decimals. Chainlink USD feeds are 8; we confirm it. */
async function feedDecimals(kh: KeeperHub, chainId: string, feed: string): Promise<number> {
  const cached = decimalsCache.get(feed);
  if (cached !== undefined) return cached;

  let decimals = 8; // sane default for Chainlink USD feeds
  try {
    const res = await kh.executeAction<string>("chainlink/decimals", {
      chainId,
      contractAddress: feed,
    });
    if (res.success && res.result != null) {
      const parsed = Number(res.result);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 36) decimals = parsed;
    }
  } catch {
    // fall through to the default
  }
  decimalsCache.set(feed, decimals);
  return decimals;
}

/** True if we have a usable Chainlink feed for this asset (for pre-flight checks). */
export function hasPriceFeed(symbol: string): boolean {
  return symbol.trim().toUpperCase() in SEPOLIA_PRICE_FEEDS;
}
