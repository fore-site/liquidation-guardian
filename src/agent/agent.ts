/**
 * The agentic rescue loop — "perceive → decide → act → re-check" until the
 * position is safe or the budget is spent.
 *
 * This is the thin agency wrapper around the Guardian's deterministic core:
 * every step still sizes amounts in code, gates levers on the wallet balance +
 * Pool allowance, simulates before broadcasting, and falls back to the
 * deterministic safeguard when the LLM is unavailable. The loop only adds
 * *re-perception* between decisions: the LLM sees the fresh onchain state and
 * the history of what it already did, so a second step can adapt (e.g. the
 * allowance is spent → switch to supply).
 *
 * Deliberately NOT a general agent loop: a closed toolset (repay/supply), a
 * bounded step count, and a wall-clock budget. Reliability first.
 */
import { KeeperHub, type AavePosition } from "../keeperhub.js";
import { createLogger } from "../log.js";
import {
  decideRescueWithFallback,
  decideRescueDeterministic,
  type RescueDecision,
} from "./decide.js";
import { buildSnapshot, executeRescue, type LlmConfig } from "./guardian.js";

const logger = createLogger("agent");

/** One executed step of the rescue run. */
export interface AgentStep {
  /** 1-based step number. */
  index: number;
  decision: RescueDecision;
  /** Which provider decided it ("gemini" | "nvidia" | "deterministic"). */
  provider: string;
  /** HF before the step. */
  hfBefore: number;
  /** HF after the step (from the post-rescue confirm read). */
  hfAfter: number;
  status: string;
  transactionLink?: string;
}

export interface AgentRunResult {
  /** "goal_met" — HF reached the safe threshold; "budget_hit" — steps/time exhausted. */
  status: "goal_met" | "budget_hit" | "healthy" | "no_action";
  position: AavePosition;
  steps: AgentStep[];
  /** Human-readable one-line summary of the run. */
  summary: string;
}

/**
 * Run the agentic rescue loop. Returns once the position is safe (HF ≥
 * threshold), the step or time budget is exhausted, or there is nothing to do.
 * Never throws for a slow/bad LLM — worst case it burns a step on the
 * deterministic safeguard and re-checks.
 */
export async function runAgenticRescue(opts: {
  keeperHub: KeeperHub;
  /** LLM stack for decisions; null → deterministic-only loop. */
  llm: LlmConfig | null;
  chainId: string;
  user: string;
  hfThreshold: number;
  hfTarget: number;
  /** Max rescue steps per run. Default 3. */
  maxSteps?: number;
  /** Wall-clock budget for the whole run, ms. Default 120s. */
  budgetMs?: number;
  /** When true, every step stops after a clean simulation — nothing broadcasts. */
  dryRun?: boolean;
}): Promise<AgentRunResult> {
  const {
    keeperHub,
    llm,
    chainId,
    user,
    hfThreshold,
    hfTarget,
    maxSteps = 3,
    budgetMs = 120_000,
    dryRun = false,
  } = opts;

  const steps: AgentStep[] = [];
  const deadline = Date.now() + budgetMs;
  let position = await keeperHub.readAavePosition(chainId, user);

  if (position.healthFactor >= hfThreshold) {
    return {
      status: "healthy",
      position,
      steps,
      summary: `Position healthy (HF ${fmtHf(position.healthFactor)}) — no action.`,
    };
  }
  if (position.totalDebtUsd <= 0) {
    return {
      status: "no_action",
      position,
      steps,
      summary: "No debt to manage — nothing to do.",
    };
  }

  const history: string[] = [];

  while (steps.length < maxSteps && Date.now() < deadline) {
    logger.info(`step ${steps.length + 1}: HF ${fmtHf(position.healthFactor)} (act below ${hfThreshold})`);

    // Perceive: size the levers on the CURRENT onchain state (balance-gated).
    const snapshot = await buildSnapshot(keeperHub, chainId, user, position);
    if (snapshot.debts.length === 0) {
      return {
        status: "no_action",
        position,
        steps,
        summary: "No debt reserves found — nothing to do.",
      };
    }

    // Decide: LLM picks a lever from the sized candidates, with history context.
    let decision: RescueDecision;
    let provider: string;
    if (llm) {
      try {
        const r = await decideRescueWithFallback({
          primary: llm.primary,
          primaryModel: llm.primaryModel,
          fallback: llm.fallback,
          fallbackModel: llm.fallbackModel,
          timeoutMs: llm.timeoutMs,
          input: {
            snapshot,
            hfThreshold,
            hfTarget,
            history: history.join("\n"),
          },
        });
        decision = r.decision;
        provider = r.source.provider;
      } catch {
        // LLM chain fully failed (e.g. both providers down) — deterministic safeguard.
        decision = decideRescueDeterministic(snapshot, hfTarget);
        provider = "deterministic";
      }
    } else {
      decision = decideRescueDeterministic(snapshot, hfTarget);
      provider = "deterministic";
    }
    logger.info(`  decided by ${provider}: ${decision.action} ${decision.amountHuman} ${decision.asset} — ${decision.reasoning}`);

    if (decision.amountUnits <= 0n) {
      // No executable lever (e.g. wallet can't cover any sized amount). Stop —
      // another step would just repeat the same failure.
      return {
        status: "budget_hit",
        position,
        steps,
        summary: "No executable lever — stopping (wallet funds or allowance insufficient).",
      };
    }

    // Act: simulate first, then broadcast (unless dry-run).
    const hfBefore = position.healthFactor;
    const result = await executeRescue({
      keeperHub,
      chainId,
      user,
      decision,
      dryRun,
      position,
    });
    const hfAfter = result.position.healthFactor;
    steps.push({
      index: steps.length + 1,
      decision,
      provider,
      hfBefore,
      hfAfter,
      status: result.status,
      transactionLink: result.transactionLink,
    });
    history.push(
      `step ${steps.length}: ${decision.action} ${decision.amountHuman} ${decision.asset} ` +
        `via ${provider} → HF ${fmtHf(hfBefore)} → ${fmtHf(hfAfter)}`,
    );
    logger.info(`  → HF ${fmtHf(hfBefore)} → ${fmtHf(hfAfter)} (${result.status})`);

    // Re-perceive for the next iteration (or exit).
    position = result.position;

    if (result.status === "simulation_failed") {
      // A step failed at simulate/execute. Don't spin: report and stop — the
      // deterministic fallback already picked its best lever; retrying the same
      // thing will fail again. The bot's watch loop will re-trigger later.
      return {
        status: "budget_hit",
        position,
        steps,
        summary: `Step ${steps.length} failed (${result.detail ?? "unknown"}) — stopping this run.`,
      };
    }

    if (position.healthFactor >= hfThreshold) {
      return {
        status: "goal_met",
        position,
        steps,
        summary: `Goal met after ${steps.length} step(s): HF ${fmtHf(position.healthFactor)} ≥ ${hfThreshold}.`,
      };
    }
  }

  const exhausted =
    steps.length >= maxSteps ? `step budget (${maxSteps})` : "time budget";
  return {
    status: "budget_hit",
    position,
    steps,
    summary: `Budget hit (${exhausted}) after ${steps.length} step(s) — HF ${fmtHf(position.healthFactor)}.`,
  };
}

function fmtHf(hf: number): string {
  return Number.isFinite(hf) ? hf.toFixed(4) : "∞";
}
