/**
 * Liquidation Guardian — the "watches" half, as a KeeperHub workflow.
 *
 * This is the deterministic, always-on monitor. It does NOT decide or execute a
 * rescue — that's the LLM + KeeperHub-execution half (src/agent/guardian.ts). Its
 * whole job is: on a schedule, read the position's health factor on-chain, and if
 * it has dropped below the act-threshold, hand off to the Guardian's decision
 * endpoint over HTTP. "Workflow watches, LLM decides, KeeperHub executes."
 *
 *   [Schedule] → [Read Aave health factor] → [Condition HF < threshold?]
 *                                                   │ true
 *                                                   ▼
 *                                          [HTTP POST → Guardian webhook]
 *
 * The graph is built here in code (the reproducible source of truth) and pushed
 * to KeeperHub by scripts/deploy-workflow.ts. Node/edge shapes are the ones the
 * live API returns (verified against the account's own workflows during the build):
 *  - the read uses the blessed protocol action `aave-v3/get-user-account-data`,
 *    which surfaces `healthFactor` (WAD, 1e18) as a top-level output field;
 *  - the Condition node carries both a visual `group` and the equivalent
 *    `condition` string (the API auto-generates one from the other);
 *  - the true edge sets `sourceHandle: "true"`.
 */
import type { WorkflowEdge, WorkflowNode } from "../keeperhub.js";

export const WORKFLOW_NAME = "Liquidation Guardian — Monitor";

export interface MonitorWorkflowOptions {
  /** Chain to watch (e.g. "11155111" Sepolia). */
  chainId: string;
  /** The borrower whose position we monitor. */
  user: string;
  /** Health factor below which we hand off (e.g. 1.15). */
  hfThreshold: number;
  /** Cron for the Schedule trigger, UTC (e.g. "*​/10 * * * *"). */
  scheduleCron: string;
  /**
   * Include the HTTP-Request handoff node (the true-branch POST to the Guardian).
   * Defaults to true. The HTTP Request action is a KeeperHub **Pro** feature
   * (`action.http-request`), so on the free plan set this false: the graph then
   * ends at the Condition and the Guardian is triggered out-of-band. See
   * docs/TEARDOWN.md (F11).
   */
  includeHandoff?: boolean;
  /**
   * Guardian decision endpoint the true branch POSTs the snapshot to. Required
   * only when {@link includeHandoff} is true.
   */
  webhookUrl?: string;
}

export interface MonitorWorkflow {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Health factor → WAD (1e18) integer string, at 6-decimal precision on the HF.
 * Done with integer math so the threshold is exact at wad scale (avoids the
 * float error of `hf * 1e18`, which isn't representable for values > 2^53).
 * e.g. 1.15 → "1150000000000000000".
 */
export function hfToWad(hf: number): string {
  const micro = BigInt(Math.round(hf * 1_000_000)); // 6 dp
  return (micro * 10n ** 12n).toString();
}

/** Label kept in sync with the {{@step-1:…}} references below. */
const READ_LABEL = "Get Aave Health Factor";

/** Build the monitor workflow graph. Pure — no network, no side effects. */
export function buildMonitorWorkflow(opts: MonitorWorkflowOptions): MonitorWorkflow {
  const includeHandoff = opts.includeHandoff ?? true;
  if (includeHandoff && !opts.webhookUrl) {
    throw new Error("buildMonitorWorkflow: webhookUrl is required when includeHandoff is true");
  }
  const thresholdWad = hfToWad(opts.hfThreshold);
  const hfRef = `{{@step-1:${READ_LABEL}.healthFactor}}`;

  const nodes: WorkflowNode[] = [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Schedule",
        config: {
          triggerType: "Schedule",
          scheduleCron: opts.scheduleCron,
          scheduleTimezone: "UTC",
        },
        status: "idle",
      },
    },
    {
      id: "step-1",
      type: "action",
      position: { x: 252, y: 0 },
      data: {
        type: "action",
        label: READ_LABEL,
        description: "Read the health factor from Aave v3 for the monitored wallet",
        config: {
          user: opts.user,
          network: opts.chainId,
          actionType: "aave-v3/get-user-account-data",
          _protocolMeta: JSON.stringify({
            protocolSlug: "aave-v3",
            contractKey: "pool",
            functionName: "getUserAccountData",
            actionType: "read",
          }),
        },
        status: "idle",
      },
    },
    {
      id: "step-2",
      type: "action",
      position: { x: 504, y: 0 },
      data: {
        type: "action",
        label: "HF below threshold?",
        description: `True when the health factor is below ${opts.hfThreshold} (act-threshold)`,
        config: {
          actionType: "Condition",
          group: {
            id: "group-1",
            logic: "AND",
            rules: [
              {
                id: "rule-1",
                operator: "<",
                leftOperand: hfRef,
                rightOperand: thresholdWad,
              },
            ],
          },
          condition: `${hfRef} < ${thresholdWad}`,
        },
        status: "idle",
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: "e-trigger-1-step-1", source: "trigger-1", target: "step-1" },
    { id: "e-step-1-step-2", source: "step-1", target: "step-2" },
  ];

  if (includeHandoff) {
    nodes.push({
      id: "step-3",
      type: "action",
      position: { x: 756, y: 0 },
      data: {
        type: "action",
        label: "Notify Guardian",
        description:
          "Hand off to the Guardian decision+execution service (the LLM-decides half)",
        config: {
          actionType: "HTTP Request",
          endpoint: opts.webhookUrl,
          httpMethod: "POST",
          httpHeaders: JSON.stringify({ "Content-Type": "application/json" }),
          // Snapshot the Guardian needs to re-read, decide, size, and rescue.
          httpBody: JSON.stringify({
            source: "keeperhub:liquidation-monitor",
            chainId: opts.chainId,
            user: opts.user,
            healthFactor: hfRef,
            thresholdWad,
            triggeredAt: "{{@__system:System.isoTimestamp}}",
          }),
          timeout: 20,
        },
        status: "idle",
      },
    });
    edges.push({
      id: "e-step-2-step-3",
      source: "step-2",
      target: "step-3",
      sourceHandle: "true",
    });
  }

  const handoffNote = includeHandoff
    ? "if it falls below the act-threshold, POSTs a snapshot to the Liquidation " +
      "Guardian's decision endpoint. The Guardian (LLM) then sizes and executes " +
      "the rescue back through KeeperHub."
    : "if it falls below the act-threshold, the true branch fires. The Liquidation " +
      "Guardian (LLM) — triggered out-of-band on the free plan — then sizes and " +
      "executes the rescue back through KeeperHub. (Add the HTTP handoff node on " +
      "KeeperHub Pro for an in-workflow webhook.)";

  return {
    name: WORKFLOW_NAME,
    description:
      "Deterministic Aave v3 health-factor watcher. On a schedule it reads the " +
      "position's HF and, " +
      handoffNote,
    nodes,
    edges,
  };
}
