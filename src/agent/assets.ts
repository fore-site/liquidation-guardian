/**
 * Aave v3 reserve registry for the demo chain (Ethereum Sepolia, 11155111).
 *
 * Addresses are the canonical Aave v3 Sepolia deployment, taken from the Aave
 * address book (bgd-labs/aave-address-book, AaveV3Sepolia). The POOL here matches
 * the `to` seen in real repay/supply calldata, so these are verified against the
 * live contract, not guessed.
 *
 * `amount` on aave-v3/repay and aave-v3/supply is in TOKEN BASE UNITS (uint256),
 * so we keep each asset's decimals here. Rescue sizing is done in token units
 * (see src/agent/decide.ts) — no USD/oracle needed for a single-asset position.
 */

export const SEPOLIA_POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";

export interface ReserveInfo {
  symbol: string;
  address: string;
  decimals: number;
  /**
   * Aave liquidation threshold in basis points (e.g. 8250 = 82.5%). Used ONLY for
   * the multi-collateral supply lever, where each collateral asset's own LT enters
   * the sizing (see src/agent/decide.ts). Single-collateral rescues use the exact
   * aggregate LT from account data instead, so this is unset for assets we haven't
   * needed it for. Values here are Aave's live Sepolia reserve config, read once via
   * the Protocol Data Provider's getReserveConfigurationData (a static-config
   * simplification: if Aave re-parameterizes a reserve, refresh these).
   */
  liqThresholdBps?: number;
}

/** Keyed by upper-case symbol. */
export const SEPOLIA_RESERVES: Record<string, ReserveInfo> = {
  USDC: { symbol: "USDC", address: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", decimals: 6, liqThresholdBps: 8500 },
  USDT: { symbol: "USDT", address: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0", decimals: 6 },
  DAI: { symbol: "DAI", address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18, liqThresholdBps: 8000 },
  GHO: { symbol: "GHO", address: "0xc4bF5CbDaBE595361438F8c6a187bDc330539c60", decimals: 18 },
  WETH: { symbol: "WETH", address: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c", decimals: 18, liqThresholdBps: 8250 },
  WBTC: { symbol: "WBTC", address: "0x29f2D40B0605204364af54EC677bD022dA425d03", decimals: 8, liqThresholdBps: 7500 },
  LINK: { symbol: "LINK", address: "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5", decimals: 18, liqThresholdBps: 7500 },
  AAVE: { symbol: "AAVE", address: "0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a", decimals: 18 },
  EURS: { symbol: "EURS", address: "0x6d906e526a4e2Ca02097BA9d0caA3c382F52278E", decimals: 2 },
};

/** Aave interest rate mode: variable-rate debt is 2 (stable-rate is retired). */
export const VARIABLE_RATE_MODE = "2";

/** The Aave test-token faucet on Sepolia: mint(token, to, amount). */
export const SEPOLIA_FAUCET = "0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D";

export function resolveReserve(symbol: string): ReserveInfo | undefined {
  return SEPOLIA_RESERVES[symbol.trim().toUpperCase()];
}

/** Convert a human token amount to base units (decimal string) for the API. */
export function toBaseUnits(reserve: ReserveInfo, human: number): string {
  return BigInt(Math.round(human * 10 ** reserve.decimals)).toString();
}

