/**
 * Typed client for the local dashboard API (server/serve.ts). The browser only
 * ever talks to /api/* — the KeeperHub key stays server-side.
 */

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

// credentials: "include" so the HttpOnly session cookie rides along on every call.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const getSession = () => request<SessionState>("/api/session");

export const openSession = (creds: Credentials) =>
  request<SessionState>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });

export const closeSession = () => request<SessionState>("/api/session", { method: "DELETE" });

export const getStatus = () => request<Status>("/api/status");
export const getRescues = () => request<Rescue[]>("/api/rescues");
