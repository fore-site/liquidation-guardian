/**
 * Typed KeeperHub REST client.
 *
 * Every endpoint here was verified against the live API (Sepolia) during the
 * hackathon build — see docs/TEARDOWN.md and docs/FIRST_TX.md. Field names match
 * the real API (chainId / recipientAddress, Idempotency-Key as a header, strict
 * boolean `simulate`).
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "./log.js";

const log = createLogger("keeperhub");

const DEFAULT_BASE = "https://app.keeperhub.com/api";

export interface KeeperHubConfig {
  apiKey: string;
  baseUrl?: string;
}

/** Result of a `simulate: true` preflight — no broadcast happened. */
export interface SimulationResult {
  success: boolean;
  status: string;
  from: string;
  to: string;
  value: string;
  gasEstimate: string;
  wouldRevert: boolean;
  simulatedReturnValue: string | null;
}

/** Result of a real broadcast (HTTP 202). */
export interface ExecutionResult {
  executionId: string;
  status: string;
  transactionHash: string;
  transactionLink: string;
}

/** Generic single-action execution response: /execute/{actionType}. */
export interface ActionResult<T = Record<string, unknown>> {
  success: boolean;
  result?: T;
  error?: string;
  addressLink?: string;
  transactionHash?: string;
  transactionLink?: string;
}

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KeeperHubError";
  }
}

/** Which HTTP statuses are safe to retry (transient upstream / rate-limit). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Default per-attempt request timeout, ms. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Max attempts incl. the first, with backoff between retries. */
const MAX_ATTEMPTS = 3;

/** Aave v3 getUserAccountData, parsed into human-readable numbers. */
export interface AavePosition {
  /** Health factor as a float. Aave liquidates at 1.0. `Infinity` = no debt. */
  healthFactor: number;
  /** Total collateral in USD (Aave base currency, 8 decimals). */
  totalCollateralUsd: number;
  /** Total debt in USD. */
  totalDebtUsd: number;
  /** Available borrows in USD. */
  availableBorrowsUsd: number;
  /** Liquidation threshold as a fraction (e.g. 0.825). */
  liquidationThreshold: number;
  /** Raw values as returned by the API, for auditing. */
  raw: Record<string, string>;
}

const WAD = 10n ** 18n; // health factor scale
const BASE_CCY = 10n ** 8n; // Aave base-currency (USD) scale
// Aave returns 2^256-1 for health factor when there is no debt.
const UINT256_MAX = 2n ** 256n - 1n;

export class KeeperHub {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: KeeperHubConfig) {
    if (!config.apiKey?.startsWith("kh_")) {
      throw new Error("KeeperHub apiKey must be a kh_-prefixed organization key.");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
  }

  /**
   * Perform a JSON request with a per-attempt timeout and automatic retry on
   * transient failures (5xx, 429 honoring Retry-After, network errors). Non-retryable
   * 4xx errors (auth, validation) fail fast on the first attempt. Every attempt is
   * timed and logged so slow/retried calls are visible in the logs.
   */
  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    let lastErr: unknown;
    let delayMs = 250;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      try {
        const res = await this.fetchOnce(method, path, opts);
        const out = await this.parseResponse<T>(res, method, path);
        log.debug(`${method} ${path} ok`, { durationMs: Date.now() - started, attempt });
        return out;
      } catch (err) {
        lastErr = err;
        const status = err instanceof KeeperHubError ? err.status : 0;
        // Non-retryable (a definitive 4xx, or a malformed response) → fail now.
        if (status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) throw err;
        // Rate limited? Respect Retry-After (bounded) instead of the fixed backoff.
        if (status === 429 && err instanceof KeeperHubError) {
          const retryAfter = Number(
            (err.body as { retryAfter?: number } | null)?.retryAfter ?? 0,
          );
          delayMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000, 15_000);
        }
        if (attempt === MAX_ATTEMPTS) break;
        log.warn(`${method} ${path} attempt ${attempt} failed`, {
          status: status || "network",
          error: err instanceof Error ? err.message : String(err),
          retryInMs: Math.round(delayMs),
          durationMs: Date.now() - started,
        });
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 8_000); // exponential backoff
      }
    }
    throw lastErr;
  }

  /** One raw HTTP attempt with a hard per-attempt timeout. */
  private async fetchOnce(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read + shape the response; throws KeeperHubError for HTTP errors. */
  private async parseResponse<T>(
    res: Response,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
  ): Promise<T> {
    const body = await safeJson(res);
    if (!res.ok) {
      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfter = Number(retryAfterRaw ?? "0");
      const detail =
        (body as { error?: string; detail?: string })?.error ??
        (body as { detail?: string })?.detail ??
        res.statusText;
      throw new KeeperHubError(
        `KeeperHub ${method} ${path}: ${detail}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? { ...(body as object), retryAfter } : body,
      );
    }
    return body as T;
  }

  /**
   * Preflight a native transfer without broadcasting. Returns gas estimate and a
   * revert check. Always call this before {@link executeTransfer}.
   */
  simulateTransfer(input: {
    chainId: string;
    recipientAddress: string;
    amount: string;
  }): Promise<SimulationResult> {
    return this.request<SimulationResult>("POST", "/execute/transfer", {
      body: { ...input, simulate: true },
    });
  }

  /** Broadcast a native transfer. A fresh idempotency key prevents double-sends. */
  executeTransfer(input: {
    chainId: string;
    recipientAddress: string;
    amount: string;
    idempotencyKey?: string;
  }): Promise<ExecutionResult> {
    const { idempotencyKey, ...body } = input;
    return this.request<ExecutionResult>("POST", "/execute/transfer", {
      body,
      idempotencyKey: idempotencyKey ?? randomUUID(),
    });
  }

  /**
   * Execute any protocol/direct action via /execute/{actionType}, e.g.
   * `aave-v3/repay`, `aave-v3/supply`, `aave-v3/get-user-account-data`.
   * Reads (no credentials) return immediately; writes return a tx hash.
   */
  executeAction<T = Record<string, unknown>>(
    actionType: string,
    body: Record<string, unknown>,
    opts: { simulate?: boolean; idempotencyKey?: string } = {},
  ): Promise<ActionResult<T>> {
    const payload = opts.simulate ? { ...body, simulate: true } : body;
    return this.request<ActionResult<T>>("POST", `/execute/${actionType}`, {
      body: payload,
      idempotencyKey: opts.simulate ? undefined : (opts.idempotencyKey ?? randomUUID()),
    }).then((res) => {
      // The API's broadcast shape ({executionId, status}) has no `success` field —
      // normalize so callers can rely on `success === true` for a clean write.
      if (
        !opts.simulate &&
        res &&
        typeof res === "object" &&
        !("success" in res) &&
        "executionId" in res
      ) {
        return { success: true, ...(res as Record<string, unknown>) } as ActionResult<T>;
      }
      return res;
    });
  }

  /** Poll a broadcast execution until terminal. */
  getExecutionStatus(executionId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/execute/${executionId}/status`);
  }

  /**
   * Call an arbitrary contract function — the generic write escape hatch, for
   * things without a dedicated action (ERC-20 approve, faucet mint, …).
   *
   * NOTE the API quirk: `functionArgs` must be a JSON-*encoded string*, not a
   * real array. We stringify here so callers pass a normal array.
   */
  contractCall(
    input: {
      chainId: string;
      contractAddress: string;
      functionName: string;
      functionArgs?: unknown[];
    },
    opts: { simulate?: boolean; idempotencyKey?: string } = {},
  ): Promise<ActionResult> {
    const body: Record<string, unknown> = {
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      functionName: input.functionName,
      functionArgs: JSON.stringify(input.functionArgs ?? []),
    };
    return this.executeAction("contract-call", body, opts);
  }

  /** Poll a broadcast execution until terminal (or timeout). */
  async waitForExecution(
    executionId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};

    while (Date.now() < deadline) {
      try {
        last = await this.getExecutionStatus(executionId);
      } catch (err) {
        // A status read failing is not fatal — keep polling until the deadline.
        log.warn(`status poll for ${executionId} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(intervalMs);
        continue;
      }
      const status = String(last.status ?? "").toLowerCase();
      if (["success", "confirmed", "failed", "reverted", "error"].includes(status)) {
        return last;
      }
      await sleep(intervalMs);
    }

    // Timed out while still pending. One final read in case the terminal status
    // landed just after the loop; then surface the (unresolved) state explicitly.
    try {
      last = await this.getExecutionStatus(executionId);
      const status = String(last.status ?? "").toLowerCase();
      if (["success", "confirmed", "failed", "reverted", "error"].includes(status)) return last;
    } catch {
      /* keep the last polled state */
    }
    throw new Error(
      `Execution ${executionId} did not reach a terminal state within ${timeoutMs}ms ` +
        `(last status: ${String(last.status ?? "unknown")}).`,
    );
  }

  /** Read + parse an Aave v3 position (health factor, collateral, debt). */
  async readAavePosition(chainId: string, user: string): Promise<AavePosition> {
    const res = await this.executeAction<Record<string, string>>(
      "aave-v3/get-user-account-data",
      { chainId, user },
    );
    if (!res.success || !res.result) {
      throw new Error(`Aave read failed: ${res.error ?? "unknown error"}`);
    }
    return parseAavePosition(res.result);
  }

  /**
   * Read a single reserve's per-user balances (token base units), incl. the
   * variable debt token balance. Lets us size a rescue in token units without an
   * oracle for a single-asset position.
   */
  async readUserReserve(
    chainId: string,
    asset: string,
    user: string,
  ): Promise<UserReserveData> {
    const res = await this.executeAction<Record<string, string>>(
      "aave-v3/get-user-reserve-data",
      { chainId, asset, user },
    );
    if (!res.success || !res.result) {
      throw new Error(`Aave reserve read failed: ${res.error ?? "unknown error"}`);
    }
    const raw = res.result;
    return {
      aTokenBalance: toBigInt(raw.currentATokenBalance, "0"),
      variableDebt: toBigInt(raw.currentVariableDebtTokenBalance, "0"),
      usageAsCollateralEnabled: raw.usageAsCollateralEnabled === "true" ||
        (raw.usageAsCollateralEnabled as unknown) === true,
      raw,
    };
  }

  // ── Workflows (the deterministic "watches" half) ───────────────────────────
  // The hosted plan does NOT expose REST create — POST /api/workflows returns
  // 405; workflows are created via the MCP `create_workflow` tool or the web UI.
  // `createWorkflow` below is kept for API completeness (other/self-hosted
  // deployments may allow it), but scripts/deploy-workflow.ts deploys by PATCHing
  // an existing workflow in place. The monitor is created *disabled* so no
  // schedule fires until the user enables it.

  /** List all workflows for the org. */
  listWorkflows(): Promise<WorkflowSummary[]> {
    return this.request<WorkflowSummary[]>("GET", "/workflows");
  }

  /**
   * Create a workflow. NOTE: the hosted KeeperHub plan returns 405 on
   * POST /api/workflows — use the MCP `create_workflow` tool or the web UI to
   * create, then PATCH via {@link updateWorkflow}. Kept for completeness.
   */
  createWorkflow(input: {
    name: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    description?: string;
    enabled?: boolean;
  }): Promise<WorkflowSummary> {
    return this.request<WorkflowSummary>("POST", "/workflows", { body: input });
  }

  /** Patch an existing workflow (nodes/edges/enabled/…). */
  updateWorkflow(
    id: string,
    patch: Partial<{
      name: string;
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      description: string;
      enabled: boolean;
    }>,
  ): Promise<WorkflowSummary> {
    return this.request<WorkflowSummary>("PATCH", `/workflows/${id}`, { body: patch });
  }

  /** Delete a workflow by id. */
  deleteWorkflow(id: string): Promise<unknown> {
    return this.request("DELETE", `/workflows/${id}`);
  }
}

/** A workflow graph node (trigger or action). Shape matches the KeeperHub API. */
export interface WorkflowNode {
  id: string;
  type: "trigger" | "action";
  position?: { x: number; y: number };
  data: {
    type: "trigger" | "action";
    label: string;
    description?: string;
    config: Record<string, unknown>;
    status?: "idle" | "running" | "success" | "error";
  };
}

/** A workflow graph edge. `sourceHandle` is only for Condition/For-Each nodes. */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: "true" | "false" | "loop" | "done";
}

/** Subset of the workflow object we read back after create/list. */
export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  [key: string]: unknown;
}

/** Per-user, per-reserve balances in token base units. */
export interface UserReserveData {
  /** Supplied collateral (aToken) balance, token base units. */
  aTokenBalance: bigint;
  /** Variable-rate debt balance, token base units. */
  variableDebt: bigint;
  usageAsCollateralEnabled: boolean;
  raw: Record<string, string>;
}

/** Convert Aave's raw getUserAccountData into human numbers. */
export function parseAavePosition(raw: Record<string, string>): AavePosition {
  const hfRaw = toBigInt(raw.healthFactor, "0");
  const healthFactor = hfRaw >= UINT256_MAX ? Infinity : Number(hfRaw) / Number(WAD);
  return {
    healthFactor,
    totalCollateralUsd: toNumber(raw.totalCollateralBase) / Number(BASE_CCY),
    totalDebtUsd: toNumber(raw.totalDebtBase) / Number(BASE_CCY),
    availableBorrowsUsd: toNumber(raw.availableBorrowsBase) / Number(BASE_CCY),
    // currentLiquidationThreshold is in basis points (e.g. 8250 = 82.5%).
    liquidationThreshold: toNumber(raw.currentLiquidationThreshold) / 10_000,
    raw,
  };
}

/** Parse a decimal string to bigint, defaulting on malformed input. */
function toBigInt(v: string | undefined, fallback: string): bigint {
  if (v == null || v === "") return BigInt(fallback);
  try {
    return BigInt(v);
  } catch {
    return BigInt(fallback);
  }
}

/** Parse a decimal string to number, defaulting to 0 on malformed input. */
function toNumber(v: string | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
