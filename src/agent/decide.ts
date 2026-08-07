/**
 * The rescue decision + sizing layer.
 *
 * The event-driven watcher (server/event-watcher.ts) does the always-on watching;
 * this module engages only once a position is actually at risk. Two jobs: (1) size
 * each possible rescue lever deterministically, in token base units; (2) let the
 * model pick which lever/asset and explain it. The model owns the *choice +
 * rationale*; the arithmetic is done in code and never trusts a model-produced
 * number.
 *
 * ## Sizing math — exact where it can be, oracle-priced only where it must be
 *
 * Aave's health factor is `HF = N / D`, with weighted collateral `N = Σ coll·price·LT`
 * and debt `D = Σ debt·price`. To restore HF to a `target`:
 *
 *   • repay debt asset k:   R_k = D·(1 − HF/target) / price_k        (capped at its debt)
 *   • supply collateral m:  S_m = D·(target − HF) / (price_m · LT_m)
 *
 * The key property: when the acted-on SIDE holds a single asset, the price (and, for
 * supply, the LT) cancels out and the lever reduces to pure token arithmetic —
 * *exact for any tokens, even collateral ≠ debt*:
 *
 *   • single debt asset:        R = debtTokens · (1 − HF/target)          (price-free)
 *   • single collateral asset:  S = collTokens · (target/HF − 1)          (price-free, LT-free)
 *
 * So a price feed is consulted ONLY when the side we act on has ≥2 assets (and a
 * per-asset LT only for the multi-collateral supply lever). The Sepolia demo is
 * LINK/LINK — one asset per side — so it makes zero oracle calls, and the math is
 * exact. See docs/ARCHITECTURE.md ("Multi-asset sizing") and docs/TEARDOWN.md (F5).
 */
import OpenAI from "openai";
import { createLogger } from "../log.js";

const log = createLogger("decide");

const WAD = 10n ** 18n;

/** One asset's contribution to a position, in token base units. */
export interface AssetPosition {
  symbol: string;
  address: string;
  decimals: number;
  /** Balance in token base units: variable debt (for a debt) or aToken (collateral). */
  tokens: bigint;
  /** USD price — required ONLY when this asset's side has ≥2 assets. */
  priceUsd?: number;
  /** Aave liquidation threshold, bps — required ONLY for the multi-collateral supply lever. */
  liqThresholdBps?: number;
}

/** The whole at-risk position: aggregate health + per-asset composition. */
export interface PositionSnapshot {
  /** Current health factor (float). Aave liquidates at 1.0. */
  healthFactor: number;
  /** Total debt in USD (Aave base currency). */
  totalDebtUsd: number;
  /** Total collateral in USD (Aave base currency). */
  totalCollateralUsd: number;
  /** Aggregate liquidation threshold as a fraction (from account data). */
  aggregateLiqThreshold: number;
  /** Debt assets (variable debt > 0). */
  debts: AssetPosition[];
  /** Collateral assets (aToken balance > 0). */
  collaterals: AssetPosition[];
  /**
   * Wallet token balances in base units, keyed by upper-case symbol. When present,
   * repay/supply levers are gated on holding enough. Absent = unknown (legacy
   * callers: availability falls back to math-only sizing).
   */
  walletBalances?: Record<string, bigint>;
  /**
   * Aave Pool allowance in base units, keyed by upper-case symbol. When present,
   * levers are gated on the Pool being allowed to pull the amount. Absent = unknown.
   */
  allowances?: Record<string, bigint>;
  /**
   * Current network gas price in Gwei, when known (fetched via RPC). Absent/null =
   * unknown — the LLM simply sees no gas figure and falls back to the
   * capital-efficiency guidance.
   */
  gasPriceGwei?: number | null;
  /**
   * ETH price in USD, when known — needed to convert gas (paid in ETH) to a USD
   * figure per lever. Absent/null = gas cost can't be priced.
   */
  ethPriceUsd?: number | null;
}

/** A single, executable rescue instruction, sized in token base units. */
export interface RescueDecision {
  action: "repay" | "supply";
  /** Token symbol to act with. */
  asset: string;
  /** Token address, so the caller builds the tx without re-resolving. */
  assetAddress: string;
  /** Amount in token BASE UNITS (what the Aave action expects). */
  amountUnits: bigint;
  /** Same amount, human-readable, for logs/audit. */
  amountHuman: number;
  /** Plain-English justification, surfaced in the audit trail and the demo. */
  reasoning: string;
}

const DEFAULT_BUFFER_BPS = 50;

// Approximate gas usage per Aave write, in gas units (contract-call sized —
// the execution-model doc measured ~75k for a simple transfer; Aave repay/supply
// are larger). Used ONLY to give the LLM a rough per-lever cost comparison; the
// authoritative figure is the simulate step's gas estimate.
const GAS_REPAY = 150_000;
const GAS_SUPPLY = 200_000;
/** Gwei → ETH: 1e-9 ETH per Gwei. */
const GWEI_TO_ETH = 1e-9;

/**
 * Estimated USD gas cost of an action. Returns null when the gas price or ETH
 * price is unknown (the caller then omits the figure from the prompt).
 */
function gasCostUsd(snap: PositionSnapshot, gasUnits: number): number | null {
  const gwei = snap.gasPriceGwei;
  const ethUsd = snap.ethPriceUsd;
  if (gwei == null || gwei <= 0 || ethUsd == null || ethUsd <= 0) return null;
  return gasUnits * gwei * GWEI_TO_ETH * ethUsd;
}

// ── Pure sizing functions (unit-tested; see scripts/test-sizing.ts) ───────────

/**
 * Base units of `asset` (a debt) to repay to restore HF to `hfTarget`, capped at
 * the outstanding debt. Price-free and exact when the debt side has one asset; uses
 * `asset.priceUsd` (throws if missing) when the debt side has ≥2 assets.
 * `bufferBps` slightly over-shoots (default 0.5%) so interest accruing between read
 * and execute can't leave us just under target.
 */
export function sizeRepay(
  asset: AssetPosition,
  snap: PositionSnapshot,
  hfTarget: number,
  bufferBps = DEFAULT_BUFFER_BPS,
): bigint {
  const hf = snap.healthFactor;
  if (!Number.isFinite(hf) || hf >= hfTarget || asset.tokens <= 0n) return 0n;
  const buffer = 1 + bufferBps / 10_000;

  if (snap.debts.length <= 1) {
    // Single debt asset: price cancels — exact bigint arithmetic.
    const factorWad = clampWad(BigInt(Math.round((1 - hf / hfTarget) * buffer * 1e18)));
    let units = (asset.tokens * factorWad) / WAD;
    if (units > asset.tokens) units = asset.tokens;
    return units;
  }

  // Multiple debt assets: the per-asset price no longer cancels.
  if (!(asset.priceUsd != null && asset.priceUsd > 0)) {
    throw new Error(
      `sizeRepay(${asset.symbol}): a multi-debt position needs this asset's USD price, but none was provided.`,
    );
  }
  const repayUsd = snap.totalDebtUsd * (1 - hf / hfTarget) * buffer;
  let units = floatTokensToBaseUnits(repayUsd / asset.priceUsd, asset.decimals);
  if (units > asset.tokens) units = asset.tokens; // can't repay more than is owed
  return units;
}

/**
 * Base units of `asset` (a collateral) to supply to restore HF to `hfTarget`.
 * Price-free and LT-free when the collateral side has one asset; uses
 * `asset.priceUsd` and `asset.liqThresholdBps` (throws if either missing) when the
 * collateral side has ≥2 assets.
 */
export function sizeSupply(
  asset: AssetPosition,
  snap: PositionSnapshot,
  hfTarget: number,
  bufferBps = DEFAULT_BUFFER_BPS,
): bigint {
  const hf = snap.healthFactor;
  if (!Number.isFinite(hf) || hf >= hfTarget || hf <= 0) return 0n;
  const buffer = 1 + bufferBps / 10_000;

  if (snap.collaterals.length <= 1) {
    // Single collateral asset: price AND LT cancel — exact bigint arithmetic.
    const factorWad = clampWad(BigInt(Math.round((hfTarget / hf - 1) * buffer * 1e18)));
    return (asset.tokens * factorWad) / WAD;
  }

  // Multiple collateral assets: this asset's own price and LT enter the sizing.
  if (!(asset.priceUsd != null && asset.priceUsd > 0)) {
    throw new Error(
      `sizeSupply(${asset.symbol}): a multi-collateral position needs this asset's USD price, but none was provided.`,
    );
  }
  if (!(asset.liqThresholdBps != null && asset.liqThresholdBps > 0)) {
    throw new Error(
      `sizeSupply(${asset.symbol}): a multi-collateral position needs this asset's liquidation threshold, but none was provided.`,
    );
  }
  const lt = asset.liqThresholdBps / 10_000;
  const supplyUsd = snap.totalDebtUsd * (hfTarget - hf) * buffer;
  return floatTokensToBaseUnits(supplyUsd / (asset.priceUsd * lt), asset.decimals);
}

function clampWad(x: bigint): bigint {
  return x < 0n ? 0n : x;
}

/**
 * Convert a float token amount to base units. Used only on the oracle-priced path,
 * where the input is already a float (price × USD) — so a final float→int rounding
 * here adds no meaningful error beyond the price itself (and the 0.5% buffer covers
 * it). The price-free path never touches this; it stays exact bigint arithmetic.
 */
function floatTokensToBaseUnits(tokens: number, decimals: number): bigint {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
  return BigInt(Math.round(tokens * 10 ** decimals));
}

function toHuman(units: bigint, decimals: number): number {
  return Number(units) / 10 ** decimals;
}

// ── Candidate enumeration ─────────────────────────────────────────────────────

/** A sized, evaluated rescue option — the raw material for both the LLM prompt and the fallback. */
export interface RescueCandidate {
  action: "repay" | "supply";
  asset: AssetPosition;
  /** Sized amount in base units (0n if unavailable). */
  amountUnits: bigint;
  amountHuman: number;
  /** This asset's USD weight (debt USD for repay, collateral USD for supply), for ranking. */
  assetUsd: number;
  /** True if this single lever, alone, reaches the target. */
  reachesTarget: boolean;
  /** False if the lever can't be sized (missing price/LT on a multi-asset side). */
  available: boolean;
  /** Why it's unavailable, if so. */
  note?: string;
  /**
   * Estimated gas cost of this lever in USD, when the gas price and a usable
   * token price are known. An estimate for the LLM's cost comparison — the
   * authoritative number is the simulate step's gas estimate.
   */
  gasCostUsd?: number | null;
}

/**
 * Size every possible lever: repay each debt, supply each collateral. Levers that
 * need a price/LT the caller didn't fetch are returned as `available: false` (never
 * guessed) so the decision layers can skip them honestly.
 */
export function computeCandidates(
  snap: PositionSnapshot,
  hfTarget: number,
  bufferBps = DEFAULT_BUFFER_BPS,
): RescueCandidate[] {
  const out: RescueCandidate[] = [];

  for (const debt of snap.debts) {
    const assetUsd = assetUsdWeight(debt, snap.totalDebtUsd, snap.debts.length);
    try {
      const units = sizeRepay(debt, snap, hfTarget, bufferBps);
      // A single-debt repay always reaches target (factor < 1, never capped). A
      // multi-debt repay reaches target only if it wasn't capped short of the
      // required amount (i.e. 0 < units < the asset's full debt).
      const reachesTarget =
        snap.debts.length <= 1 ? units > 0n : units > 0n && units < debt.tokens;
      const gate = executability(snap, debt, units);
      out.push({
        action: "repay",
        asset: debt,
        amountUnits: units,
        amountHuman: toHuman(units, debt.decimals),
        assetUsd,
        reachesTarget,
        available: units > 0n && gate.available,
        note: units > 0n ? gate.note : "computed amount is zero",
        gasCostUsd: gasCostUsd(snap, GAS_REPAY),
      });
    } catch (err) {
      out.push({
        action: "repay",
        asset: debt,
        amountUnits: 0n,
        amountHuman: 0,
        assetUsd,
        reachesTarget: false,
        available: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const coll of snap.collaterals) {
    const assetUsd = assetUsdWeight(coll, snap.totalCollateralUsd, snap.collaterals.length);
    try {
      const units = sizeSupply(coll, snap, hfTarget, bufferBps);
      const gate = executability(snap, coll, units);
      out.push({
        action: "supply",
        asset: coll,
        amountUnits: units,
        amountHuman: toHuman(units, coll.decimals),
        assetUsd,
        reachesTarget: units > 0n, // supply is never capped — it always reaches target
        available: units > 0n && gate.available,
        note: units > 0n ? gate.note : "computed amount is zero",
        gasCostUsd: gasCostUsd(snap, GAS_SUPPLY),
      });
    } catch (err) {
      out.push({
        action: "supply",
        asset: coll,
        amountUnits: 0n,
        amountHuman: 0,
        assetUsd,
        reachesTarget: false,
        available: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}

/**
 * Executability gate for a sized lever: when the snapshot carries the wallet's
 * token balance and Pool allowance, the lever is only executable if the wallet
 * holds enough AND has allowed the Pool to pull it. Without that data (legacy
 * callers / tests), the lever is assumed executable — math-only sizing.
 *
 * Aave pulls the token from the wallet for both repay and supply, so the same
 * balance + allowance check covers both actions.
 */
function executability(
  snap: PositionSnapshot,
  asset: AssetPosition,
  units: bigint,
): { available: boolean; note?: string } {
  const symbol = asset.symbol.toUpperCase();
  const problems: string[] = [];

  const balance = snap.walletBalances?.[symbol];
  if (balance !== undefined) {
    if (balance < units) {
      problems.push(`wallet holds ${toHuman(balance, asset.decimals)} ${asset.symbol}, needs ${toHuman(units, asset.decimals)}`);
    }
  }
  const allowance = snap.allowances?.[symbol];
  if (allowance !== undefined) {
    if (allowance < units) {
      problems.push(`Pool allowance ${toHuman(allowance, asset.decimals)} ${asset.symbol}, needs ${toHuman(units, asset.decimals)}`);
    }
  }

  return {
    available: problems.length === 0,
    note: problems.length > 0 ? `unavailable: ${problems.join("; ")}` : undefined,
  };
}

/** USD weight of one asset: exact (whole side) for a single-asset side, else price×tokens. */
function assetUsdWeight(asset: AssetPosition, sideTotalUsd: number, sideLen: number): number {
  if (sideLen <= 1) return sideTotalUsd;
  if (asset.priceUsd != null && asset.priceUsd > 0) {
    return (Number(asset.tokens) / 10 ** asset.decimals) * asset.priceUsd;
  }
  return 0;
}

/**
 * Turn a sized {@link RescueCandidate} into an executable {@link RescueDecision}
 * with a given rationale. Exported so a caller (the Telegram bot) can execute a
 * *specific user-chosen* lever without re-running the LLM — it picks the candidate
 * off the sized list and passes it straight here.
 */
export function candidateToDecision(c: RescueCandidate, reasoning: string): RescueDecision {
  return {
    action: c.action,
    asset: c.asset.symbol,
    assetAddress: c.asset.address,
    amountUnits: c.amountUnits,
    amountHuman: c.amountHuman,
    reasoning,
  };
}

// ── LLM decision ──────────────────────────────────────────────────────────────

/**
 * OpenAI-compatible tool the model is forced to call — guarantees a parseable
 * decision. `strict` adds `additionalProperties: false` to the schema, which
 * OpenAI-compatible endpoints that enforce strict output require.
 */
function decisionTool(strict: boolean): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: "submit_rescue_decision",
      description:
        "Choose the single rescue lever (which action, on which asset) that restores the position's health factor to target.",
      parameters: {
        type: "object",
        ...(strict ? { additionalProperties: false } : {}),
        properties: {
          action: {
            type: "string",
            enum: ["repay", "supply"],
            description:
              "repay = pay down a borrowed debt asset (most capital-efficient, frees borrowing power). " +
              "supply = add more of a collateral asset (keeps the debt open).",
          },
          assetSymbol: {
            type: "string",
            description:
              "The token symbol to act on — MUST be one of the assets listed as an available option.",
          },
          reasoning: {
            type: "string",
            description: "One or two sentences: why this action on this asset for this position.",
          },
        },
        required: ["action", "assetSymbol", "reasoning"],
      },
    },
  };
}

export interface DecideInput {
  snapshot: PositionSnapshot;
  hfThreshold: number;
  hfTarget: number;
  /**
   * Multi-step context: what earlier steps of this rescue run already did
   * ("step 1: repaid 153.9 LINK → HF 1.0865 → 1.3012"). Empty string
   * means this is the first decision. Lets the model reason across steps instead
   * of treating every decision as stateless.
   */
  history?: string;
  /** Model id served by the configured base URL — required for the LLM call. */
  model: string;
  bufferBps?: number;
  /** Hard per-attempt budget in ms. When it lapses, the request is aborted. */
  timeoutMs?: number;
  /** Some OpenAI-compatible endpoints need `additionalProperties: false` in the tool schema. */
  strictSchema?: boolean;
}

/**
 * Ask the configured LLM (OpenAI-compatible endpoint) to pick the rescue lever.
 * Amounts are computed here (not by the model); the model picks the action +
 * asset among the sized, available options and explains it. Falls back to
 * {@link decideRescueDeterministic} if the model picks something unavailable.
 * Returns a structured, code-sized {@link RescueDecision}.
 */
export async function decideRescue(
  client: OpenAI,
  input: DecideInput,
): Promise<RescueDecision> {
  const { snapshot, hfThreshold, hfTarget } = input;
  const candidates = computeCandidates(snapshot, hfTarget, input.bufferBps);
  const available = candidates.filter((c) => c.available);
  if (available.length === 0) {
    throw new Error("No available rescue lever (every option is unpriceable or zero-sized).");
  }

  const gasSuffix = (c: RescueCandidate): string =>
    c.gasCostUsd != null && c.gasCostUsd > 0 ? ` (gas ~$${c.gasCostUsd.toFixed(2)})` : "";
  const repayLines = candidates
    .filter((c) => c.action === "repay")
    .map((c) =>
      c.available
        ? `  • repay ${fmt(c.amountHuman)} ${c.asset.symbol}` +
          (c.reachesTarget ? "" : " (partial — largest single repay can't reach target alone)") +
          gasSuffix(c)
        : `  • repay ${c.asset.symbol} — unavailable (${c.note})`,
    );
  const supplyLines = candidates
    .filter((c) => c.action === "supply")
    .map((c) =>
      c.available
        ? `  • supply ${fmt(c.amountHuman)} ${c.asset.symbol} more collateral` + gasSuffix(c)
        : `  • supply ${c.asset.symbol} — unavailable (${c.note})`,
    );

  const fundsLine = buildFundsLine(snapshot);
  const history = input.history?.trim();
  const historyLine = history
    ? `Previous actions in this rescue run: ${history}`
    : "This is the first decision of this rescue run.";

  // Gas-aware guidance only when the snapshot carries a gas price — otherwise the
  // LLM falls back to the capital-efficiency rule.
  const gasKnown = snapshot.gasPriceGwei != null && snapshot.gasPriceGwei > 0;
  const costGuidance = gasKnown
    ? [
        `Choose the lever that restores HF to target at the LOWEST TOTAL COST to the user`,
        `(tokens spent + the gas estimate shown per lever). If two levers are close, prefer`,
        `repay when the debt asset is on hand.`,
      ]
    : [
        `Prefer repay when the debt asset is on hand (more capital-efficient, frees`,
        `borrowing power); prefer supply when you'd rather not spend down the debt asset.`,
      ];

  const prompt = [
    `A DeFi borrow position on Aave v3 is approaching liquidation.`,
    ``,
    `Health factor: ${fmt(snapshot.healthFactor)} (liquidation at 1.0; we act below ${hfThreshold}).`,
    `Total debt: $${fmt(snapshot.totalDebtUsd)} · total collateral: $${fmt(snapshot.totalCollateralUsd)}`,
    `Target health factor to restore: ${hfTarget}`,
    ``,
    historyLine,
    ``,
    `Debt assets: ${snapshot.debts.map((d) => d.symbol).join(", ") || "none"}`,
    `Collateral assets: ${snapshot.collaterals.map((c) => c.symbol).join(", ") || "none"}`,
    ``,
    `Available rescue levers (amounts computed exactly by the sizing layer):`,
    ...repayLines,
    ...supplyLines,
    ``,
    fundsLine,
    ``,
    `Choose ONE lever and call submit_rescue_decision with its action and assetSymbol.`,
    ...costGuidance,
    `Only pick an asset listed as available. If no lever is available, do NOT invent`,
    `one — the caller will fall back to a deterministic safeguard.`,
  ].join("\n");

  // Forcing the tool guarantees structured output. (Extended thinking isn't
  // compatible with a forced tool_choice; the arithmetic is deterministic above.)
  const strict = input.strictSchema ?? false;
  const tool = decisionTool(strict);
  const completion = await client.chat.completions.create(
    {
      model: input.model,
      max_tokens: 1024,
      tools: [tool],
      // Some OpenAI-compatible endpoints don't accept the named-function
      // tool_choice form; with a single tool, "required" is equivalent and
      // works across providers.
      tool_choice: strict ? "required" : { type: "function", function: { name: tool.function.name } },
      messages: [{ role: "user", content: prompt }],
    },
    // Hard per-attempt budget: abort the request if the provider is slow, so the
    // caller (fallback chain) can move on quickly.
    input.timeoutMs != null ? { signal: AbortSignal.timeout(input.timeoutMs) } : undefined,
  );

  const toolCall = completion.choices[0]?.message.tool_calls?.[0];
  if (!toolCall?.function) throw new Error("Model did not return a rescue decision.");
  let raw: { action: string; assetSymbol?: string; reasoning?: string };
  try {
    raw = JSON.parse(toolCall.function.arguments) as {
      action: string;
      assetSymbol?: string;
      reasoning?: string;
    };
  } catch {
    // Model returned unparseable JSON — protect the position deterministically.
    return decideRescueDeterministic(snapshot, hfTarget, input.bufferBps);
  }
  if (typeof raw !== "object" || raw === null || typeof raw.action !== "string") {
    return decideRescueDeterministic(snapshot, hfTarget, input.bufferBps);
  }

  const wantAction = raw.action === "supply" ? "supply" : "repay";
  const wantSymbol = (raw.assetSymbol ?? "").trim().toUpperCase();
  const picked = available.find(
    (c) => c.action === wantAction && c.asset.symbol.toUpperCase() === wantSymbol,
  );

  if (!picked) {
    // Model chose something we can't execute — protect the position deterministically.
    return decideRescueDeterministic(snapshot, hfTarget, input.bufferBps);
  }
  return candidateToDecision(picked, (raw.reasoning ?? "").trim());
}

/** Which provider produced a decision, for logs/audit. */
export interface DecisionSource {
  provider: "llm" | "deterministic";
  detail?: string;
}

/**
 * Ask the configured LLM (any OpenAI-compatible endpoint) for a decision with a
 * short per-attempt budget. On failure (slow/down model, unparseable output) it
 * falls through to the deterministic sizing, which keeps the position protected —
 * reliability first.
 */
export async function decideRescueWithLlm(opts: {
  client: OpenAI;
  /** Model id served by the configured base URL. */
  model: string;
  /** Per-attempt budget in ms. */
  timeoutMs?: number;
  input: Omit<DecideInput, "model" | "timeoutMs">;
}): Promise<{ decision: RescueDecision; source: DecisionSource }> {
  try {
    const decision = await decideRescue(opts.client, {
      ...opts.input,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    });
    return { decision, source: { provider: "llm" } };
  } catch (err) {
    log.warn("LLM decision failed; using deterministic sizing", {
      error: err instanceof Error ? err.message : String(err),
    });
    const decision = decideRescueDeterministic(
      opts.input.snapshot,
      opts.input.hfTarget,
      opts.input.bufferBps,
    );
    return { decision, source: { provider: "deterministic" } };
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Human-readable wallet funds line for the LLM prompt: balances + Pool allowances
 * per asset, when the snapshot carries them (the guardian fetches both).
 */
function buildFundsLine(snap: PositionSnapshot): string {
  const bal = snap.walletBalances;
  const allow = snap.allowances;
  if (!bal && !allow) return "Wallet balances: not provided.";

  const assets = new Set<string>([
    ...snap.debts.map((d) => d.symbol.toUpperCase()),
    ...snap.collaterals.map((c) => c.symbol.toUpperCase()),
  ]);
  const parts: string[] = [];
  for (const symbol of assets) {
    const asset = snap.debts.find((d) => d.symbol.toUpperCase() === symbol) ??
      snap.collaterals.find((c) => c.symbol.toUpperCase() === symbol);
    if (!asset) continue;
    const decimals = asset.decimals;
    const balance = bal?.[symbol];
    const allowance = allow?.[symbol];
    const bits: string[] = [];
    if (balance !== undefined) bits.push(`balance ${toHuman(balance, decimals)}`);
    if (allowance !== undefined) bits.push(`Pool allowance ${toHuman(allowance, decimals)}`);
    parts.push(`${symbol}: ${bits.join(" · ") || "unknown"}`);
  }
  return `Wallet funds: ${parts.join(" | ")}`;
}

/**
 * Deterministic fallback decision — no LLM. Repay the largest single debt that
 * reaches target alone; else the largest debt (best-effort partial, one action per
 * pass); else, with no debt to repay, supply the cheapest-in-tokens collateral. This
 * keeps the position protected even when the LLM is unreachable: reliability first.
 */
export function decideRescueDeterministic(
  snap: PositionSnapshot,
  hfTarget: number,
  bufferBps = DEFAULT_BUFFER_BPS,
): RescueDecision {
  const candidates = computeCandidates(snap, hfTarget, bufferBps);
  const repays = candidates.filter((c) => c.action === "repay" && c.available && c.amountUnits > 0n);
  const supplies = candidates.filter((c) => c.action === "supply" && c.available && c.amountUnits > 0n);

  const reaching = repays.filter((c) => c.reachesTarget);
  const bestReaching = maxBy(reaching, (c) => c.assetUsd);
  if (bestReaching) {
    return candidateToDecision(
      bestReaching,
      `Deterministic fallback (LLM unavailable): repay ${fmt(bestReaching.amountHuman)} ` +
        `${bestReaching.asset.symbol} — the largest single debt that restores HF to ${hfTarget} alone.`,
    );
  }

  const bestRepay = maxBy(repays, (c) => c.assetUsd);
  if (bestRepay) {
    return candidateToDecision(
      bestRepay,
      `Deterministic fallback (LLM unavailable): repay ${fmt(bestRepay.amountHuman)} ` +
        `${bestRepay.asset.symbol} (largest debt) as a best-effort partial rescue; no single ` +
        `debt reaches HF ${hfTarget} alone.`,
    );
  }

  // No repayable debt — add collateral. Pick the smallest token amount to supply.
  const cheapest = minBy(supplies, (c) => c.amountHuman);
  if (cheapest) {
    return candidateToDecision(
      cheapest,
      `Deterministic fallback (LLM unavailable): supply ${fmt(cheapest.amountHuman)} ` +
        `${cheapest.asset.symbol} to restore HF to ${hfTarget}.`,
    );
  }

  throw new Error("No available rescue lever to size a deterministic decision.");
}

function maxBy<T>(arr: T[], key: (t: T) => number): T | undefined {
  return arr.reduce<T | undefined>(
    (best, cur) => (best === undefined || key(cur) > key(best) ? cur : best),
    undefined,
  );
}

function minBy<T>(arr: T[], key: (t: T) => number): T | undefined {
  return arr.reduce<T | undefined>(
    (best, cur) => (best === undefined || key(cur) < key(best) ? cur : best),
    undefined,
  );
}
