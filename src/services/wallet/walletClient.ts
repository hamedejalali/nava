import crypto from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Wallet API client (Nava → Wallet), Flow A («آدرس واریز»). Exactly the contract of the Wallet's integration spec:
 *   Authorization: Bearer <WALLET_INTEGRATION_ID>.<WALLET_API_SECRET>
 *   X-Wallet-Timestamp (unix seconds) + X-Wallet-Nonce (NEW 32 hex chars on every request, retries included)
 * The secret is read from the environment only and is never logged, never put in a URL or an error message.
 */

export interface WalletTx {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "REQUIRES_RECONCILIATION" | string;
  amount: number;
  fee: number;
  total: number;
  fee_percent?: number;
  external_user_id?: string;
  idempotency_key?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
  completed_at?: string | null;
  failure_code?: string | null;
  /** what Nava must credit: already net of the fee. NEVER use `amount`/`total`. */
  delivered_amount?: number;
  total_charged?: number;
  fee_mode?: string;
  source?: string;
}

export class WalletApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "WalletApiError";
  }
}

export function walletBaseUrl(): string | null {
  const raw = env.wallet.url;
  if (!raw) return null;
  const u = raw.replace(/\/+$/, "");
  return /^https:\/\/[^\s]+$/i.test(u) ? u : null; // HTTPS only (the Wallet refuses plain HTTP: HTTPS_REQUIRED)
}

export function walletConfigured(): boolean {
  return !!(walletBaseUrl() && env.wallet.integrationId && env.wallet.secret);
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; json(): Promise<any> }>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
/** test seam only */
export function __setWalletFetch(f: FetchLike | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init) as any);
}

/** One signed call. Returns the parsed JSON body. Throws WalletApiError (retryable = timeout / 5xx / 429). */
export async function walletCall(method: "GET" | "POST", path: string, body?: unknown): Promise<{ json: any; status: number }> {
  const base = walletBaseUrl();
  if (!base || !env.wallet.integrationId || !env.wallet.secret) throw new WalletApiError("NOT_CONFIGURED", 0, false);
  let res;
  try {
    res = await fetchImpl(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.wallet.integrationId}.${env.wallet.secret}`,
        "X-Wallet-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Wallet-Nonce": crypto.randomBytes(16).toString("hex"), // new for every call
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // timeout / DNS / connection reset: NOT a failure — the caller asks again later
    throw new WalletApiError("NETWORK", 0, true);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json?.error?.code === "string" ? json.error.code.slice(0, 64) : `HTTP_${res.status}`;
    const ra = Number(res.headers.get("retry-after"));
    throw new WalletApiError(code, res.status, res.status >= 500 || res.status === 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  return { json, status: res.status };
}

export interface DepositCode {
  address: string;
  external_user_id?: string;
}

/** The user's fixed deposit address (JTX-XXXX-XXXX-XXXX-XXXX). Calling again returns the same one. */
export async function requestDepositCode(externalUserId: string): Promise<DepositCode> {
  const { json } = await walletCall("POST", "/deposit-codes", { external_user_id: externalUserId });
  const dc = json?.deposit_code;
  const address = typeof dc?.address === "string" ? dc.address : typeof dc?.code === "string" ? dc.code : "";
  if (!ADDRESS_RE.test(address)) throw new WalletApiError("BAD_RESPONSE", 200, true);
  return { address, external_user_id: dc?.external_user_id };
}

export const ADDRESS_RE = /^JTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** COMPLETED transfers, oldest first. `completedAfter` is inclusive on the Wallet side → de-duplicate by id. */
export async function listCompletedTransfers(p: { completedAfter?: string; externalUserId?: string; limit?: number }): Promise<WalletTx[]> {
  const q = new URLSearchParams({ status: "COMPLETED", limit: String(p.limit ?? 100) });
  if (p.completedAfter) q.set("completed_after", p.completedAfter);
  if (p.externalUserId) q.set("external_user_id", p.externalUserId);
  const { json } = await walletCall("GET", "/transfers?" + q.toString());
  const list = json?.transactions;
  if (!Array.isArray(list)) throw new WalletApiError("BAD_RESPONSE", 200, true);
  return list.filter((t: any) => t && typeof t.id === "string");
}
