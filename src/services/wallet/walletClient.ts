import crypto from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Wallet API client (Nava → Wallet). Exactly the contract of the Wallet's integration spec:
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

export async function walletRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<{ tx: WalletTx; status: number; replayed: boolean }> {
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
    // timeout / DNS / connection reset: NOT a failure of the transfer — the caller retries with the same key
    throw new WalletApiError("NETWORK", 0, true);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json?.error?.code === "string" ? json.error.code.slice(0, 64) : `HTTP_${res.status}`;
    const ra = Number(res.headers.get("retry-after"));
    throw new WalletApiError(code, res.status, res.status >= 500 || res.status === 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  const tx = json?.transaction;
  if (!tx || typeof tx.id !== "string") throw new WalletApiError("BAD_RESPONSE", res.status, true);
  return { tx, status: res.status, replayed: json?.replayed === true };
}

/** 1) create the transfer request. Safe to repeat with the SAME idempotency key. */
export const createWalletTransfer = (p: { idempotencyKey: string; externalUserId: string; walletToken: string; amount: number; note?: string }) =>
  walletRequest("POST", "/transfers", {
    idempotency_key: p.idempotencyKey,
    external_user_id: p.externalUserId,
    wallet_token: p.walletToken,
    amount: p.amount,
    ...(p.note ? { metadata: { note: p.note.slice(0, 200) } } : {}),
  });

/** 2) read it back. Only a COMPLETED answer from here means XP really moved. */
export const getWalletTransfer = (id: string) => walletRequest("GET", "/transfers/" + encodeURIComponent(id));
