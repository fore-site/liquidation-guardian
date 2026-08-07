/**
 * Typed client for the Guardian API — calls the TanStack Start server
 * functions directly (they run server-side; the KeeperHub key never leaves the
 * server). The HttpOnly session cookie rides along on the fetch automatically.
 */

// Types stay here so components import from one place.
export interface Asset {
  symbol: string;
  address: string;
  decimals: number;
  tokens: string;
  tokensHuman: number;
  priceUsd: number | null;
}

export interface Candidate {
  action: "repay" | "supply";
  asset: string;
  amountUnits: string;
  amountHuman: number;
  reachesTarget: boolean;
  available: boolean;
  note: string | null;
}

export interface Status {
  wallet: string;
  chainId: string;
  hfThreshold: number;
  hfTarget: number;
  healthFactor: number | null;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThreshold: number;
  debts: Asset[];
  collaterals: Asset[];
  candidates: Candidate[];
  updatedAt: string;
}

export interface Rescue {
  type: "repay" | "supply";
  asset: string;
  amountHuman: number;
  txHash: string;
  block: number;
  link: string;
}

export interface SessionConfig {
  wallet: string;
  chainId: string;
  hfThreshold: number;
  hfTarget: number;
}

export interface SessionState {
  authenticated: boolean;
  config?: SessionConfig;
}

/** What the onboarding form collects. The key is sent once and held server-side. */
export interface Credentials {
  keeperHubApiKey: string;
  wallet: string;
  chainId: string;
  hfThreshold: number;
  hfTarget: number;
  /** Telegram Mini App signed session, when onboarding from inside Telegram. */
  initData?: string;
}

// ── Server functions (imported from the server module) ────────────────────────
// The heavy server logic lives in *.server.ts modules; this module holds the
// server fns Start compiles into client-safe proxies.
import {
  closeSessionFn,
  getRescuesFn,
  getSessionFn,
  getStatusFn,
  openSessionFn,
} from "./server/api.js";

/**
 * Response-shape guard: a server fn returns plain data, or a Response. Session
 * POST/DELETE return a Response even on SUCCESS (to carry the Set-Cookie
 * header), so only treat >=400 Responses as errors.
 */
async function unwrap<T>(r: unknown): Promise<T> {
  if (r instanceof Response) {
    if (r.status >= 400) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Request failed (${r.status})`);
    }
    return (await r.json()) as T;
  }
  return r as T;
}

export const getSession = () => getSessionFn().then((r) => unwrap<SessionState>(r));

export const openSession = (creds: Credentials) =>
  openSessionFn({ data: creds }).then((r) => unwrap<SessionState>(r));

export const closeSession = () => closeSessionFn().then((r) => unwrap<SessionState>(r));

export const getStatus = () => getStatusFn().then((r) => unwrap<Status>(r));

export const getRescues = () => getRescuesFn().then((r) => unwrap<Rescue[]>(r));
