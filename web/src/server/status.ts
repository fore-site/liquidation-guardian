/**
 * Build the /api/status payload: live position + sized rescue levers, exactly
 * as read-position / the guardian do. Ported from the old serve.ts handler.
 */
import { buildSnapshot } from "@guardian/src/agent/guardian.js";
import { computeCandidates, type AssetPosition, type RescueCandidate } from "@guardian/src/agent/decide.js";
import type { GuardianRecord } from "@guardian/server/store.js";
import { getContext } from "./bootstrap.js";

/** Serialize an AssetPosition (bigint → string) for JSON. */
function assetDto(a: AssetPosition) {
  return {
    symbol: a.symbol,
    address: a.address,
    decimals: a.decimals,
    tokens: a.tokens.toString(),
    tokensHuman: Number(a.tokens) / 10 ** a.decimals,
    priceUsd: a.priceUsd ?? null,
  };
}

/** Serialize a sized rescue lever for JSON. */
function candidateDto(c: RescueCandidate) {
  return {
    action: c.action,
    asset: c.asset.symbol,
    amountUnits: c.amountUnits.toString(),
    amountHuman: c.amountHuman,
    reachesTarget: c.reachesTarget,
    available: c.available,
    note: c.note ?? null,
    gasCostUsd: c.gasCostUsd ?? null,
  };
}

export async function buildStatus(record: GuardianRecord) {
  const { store } = getContext();
  const kh = store.keeperHubFor(record);
  const position = await kh.readAavePosition(record.chainId, record.wallet);
  const hasDebt = Number.isFinite(position.healthFactor) && position.totalDebtUsd > 0;

  // buildSnapshot fetches prices only for a side with ≥2 assets; LINK/LINK reads none.
  const snapshot = hasDebt ? await buildSnapshot(kh, record.chainId, record.wallet, position) : null;
  const candidates =
    snapshot && position.healthFactor < record.hfTarget ? computeCandidates(snapshot, record.hfTarget) : [];

  return {
    wallet: record.wallet,
    chainId: record.chainId,
    hfThreshold: record.hfThreshold,
    hfTarget: record.hfTarget,
    autoMode: record.autoMode,
    healthFactor: Number.isFinite(position.healthFactor) ? position.healthFactor : null,
    totalCollateralUsd: position.totalCollateralUsd,
    totalDebtUsd: position.totalDebtUsd,
    availableBorrowsUsd: position.availableBorrowsUsd,
    liquidationThreshold: position.liquidationThreshold,
    debts: snapshot ? snapshot.debts.map(assetDto) : [],
    collaterals: snapshot ? snapshot.collaterals.map(assetDto) : [],
    candidates: candidates.map(candidateDto),
    updatedAt: new Date().toISOString(),
  };
}
