import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";
import { checkRateLimit, peekRateLimit } from "../../utils/rateLimit.js";

/**
 * AUTHENTICATION OF THE WALLET INTEGRATION (not of users).
 *
 * Every request carries an HMAC-SHA256 signature made with a secret only the Wallet and Nava know:
 *
 *   X-Wallet-Key-Id     identifies the integration (WALLET_API_KEY_ID)
 *   X-Wallet-Timestamp  unix seconds; accepted within ±300 s
 *   X-Wallet-Nonce      16..64 chars [A-Za-z0-9_-], single use (replay protection, stored 15 min)
 *   X-Wallet-Signature  hex( HMAC_SHA256(secret, canonical) )
 *
 *   canonical = "v1\n" + timestamp + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(rawBody)
 *
 * Order of checks: configured -> switched on -> failure throttle -> headers -> key id -> timestamp -> signature
 * -> nonce (only a request with a VALID signature may use up a nonce) -> request budget.
 */

export const SIGNATURE_VERSION = "v1";
export const MAX_CLOCK_SKEW_S = 300;
export const NONCE_TTL_MS = 15 * 60_000;
export const WALLET_CALLS_PER_MINUTE = 120;
export const AUTH_FAILURES_PER_5MIN = 30;

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface WalletRequestInfo {
  method: string;
  /** canonical path, e.g. /api/wallet/v1/credit (no query string) */
  path: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  /** injectable clock (ms) for tests */
  nowMs?: number;
}

export type WalletAuthResult = { ok: true; keyId: string } | { ok: false; status: number; code: string; alert?: boolean };

function header(h: WalletRequestInfo["headers"], name: string): string {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function canonicalString(ts: string, nonce: string, method: string, path: string, rawBody: string): string {
  return [SIGNATURE_VERSION, ts, nonce, method.toUpperCase(), path, sha256Hex(rawBody)].join("\n");
}

/** What the Wallet runs to sign a request (also used by the tests and documented in docs/WALLET_API.md). */
export function signWalletRequest(secret: string, ts: string, nonce: string, method: string, path: string, rawBody: string): string {
  return createHmac("sha256", secret).update(canonicalString(ts, nonce, method, path, rawBody)).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function safeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Owner switch (admin panel) — default ON once the secrets are configured. */
export async function isWalletIntegrationEnabled(): Promise<boolean> {
  const doc = await (await getDb()).collection<any>("wallet_integration").findOne({ _id: "singleton" });
  return doc?.enabled !== false;
}
export async function setWalletIntegrationEnabled(on: boolean, by: number): Promise<void> {
  await (await getDb()).collection<any>("wallet_integration").updateOne({ _id: "singleton" }, { $set: { enabled: on, changedAt: new Date(), changedBy: by } }, { upsert: true });
}

let indexed = false;
export async function ensureWalletIndexes(): Promise<void> {
  if (indexed) return;
  const db = await getDb();
  await db.collection("wallet_nonces").createIndexes([{ key: { expiresAt: 1 }, name: "nonce_ttl", expireAfterSeconds: 0 }]);
  await db.collection("wallet_audit").createIndexes([{ key: { at: 1 }, name: "audit_ttl", expireAfterSeconds: 90 * 86_400 }]);
  await db.collection("xp_wallet_transfers").createIndexes([
    { key: { idempotencyKey: 1 }, name: "idempotency_unique", unique: true },
    { key: { userId: 1, createdAt: -1 }, name: "user_created" },
  ]);
  indexed = true;
}
export function resetWalletIndexMemo(): void {
  indexed = false;
}

/** Audit trail WITHOUT credentials: never the secret, signature, token or body — only ids, codes and a hashed ip. */
export async function auditWallet(entry: { op: string; code: string; keyId?: string; ip?: string; transactionId?: string; userId?: number; amount?: number }): Promise<void> {
  try {
    await (await getDb()).collection<any>("wallet_audit").insertOne({
      at: new Date(),
      op: entry.op,
      code: entry.code,
      keyId: entry.keyId?.slice(0, 40),
      ipHash: entry.ip ? sha256Hex(`wallet-ip:${entry.ip}`).slice(0, 16) : undefined,
      transactionId: entry.transactionId?.slice(0, 64),
      userId: entry.userId,
      amount: entry.amount,
    });
  } catch {
    /* auditing must never break a request */
  }
}

function ipBucketId(ip: string): number {
  // the limiter keys its documents by a number; derive a stable one from the (hashed) address
  return parseInt(sha256Hex(`wallet-rl:${ip}`).slice(0, 8), 16);
}

export async function authenticateWalletRequest(req: WalletRequestInfo, op = "?"): Promise<WalletAuthResult> {
  const keyId = env.wallet.keyId;
  const secret = env.wallet.secret;
  if (!keyId || !secret) return { ok: false, status: 503, code: "integration_not_configured" };
  if (!(await isWalletIntegrationEnabled())) return { ok: false, status: 403, code: "integration_disabled" };

  const ipId = ipBucketId(req.ip);
  if ((await peekRateLimit(ipId, "wallet-auth-fail", 5 * 60_000)) >= AUTH_FAILURES_PER_5MIN) return { ok: false, status: 429, code: "too_many_failures" };

  const fail = async (status: number, code: string): Promise<WalletAuthResult> => {
    const r = await checkRateLimit(ipId, "wallet-auth-fail", AUTH_FAILURES_PER_5MIN, 5 * 60_000).catch(() => null);
    await auditWallet({ op, code, ip: req.ip });
    return { ok: false, status, code, alert: r?.justExceeded === true };
  };

  const hKey = header(req.headers, "x-wallet-key-id");
  const hTs = header(req.headers, "x-wallet-timestamp");
  const hNonce = header(req.headers, "x-wallet-nonce");
  const hSig = header(req.headers, "x-wallet-signature").toLowerCase();
  if (!hKey || !hTs || !hNonce || !hSig) return fail(401, "missing_auth_headers");
  if (!safeEqualStr(hKey, keyId)) return fail(401, "invalid_credentials");
  if (!/^\d{9,12}$/.test(hTs)) return fail(401, "invalid_timestamp");
  const nowMs = req.nowMs ?? Date.now();
  if (Math.abs(Math.floor(nowMs / 1000) - Number(hTs)) > MAX_CLOCK_SKEW_S) return fail(401, "timestamp_out_of_window");
  if (!NONCE_RE.test(hNonce)) return fail(401, "invalid_nonce");

  const secrets = [secret, env.wallet.secretNext].filter((x): x is string => !!x);
  const good = secrets.map((sec) => safeEqualHex(signWalletRequest(sec, hTs, hNonce, req.method, req.path, req.rawBody), hSig)).some(Boolean);
  if (!good) return fail(401, "invalid_signature");

  // replay protection: a validly signed nonce works exactly once
  try {
    await (await getDb()).collection<any>("wallet_nonces").insertOne({ _id: `${keyId}:${hNonce}`, at: new Date(nowMs), expiresAt: new Date(nowMs + NONCE_TTL_MS) });
  } catch (err: any) {
    if (err?.code === 11000) {
      await auditWallet({ op, code: "replayed_request", keyId, ip: req.ip });
      return { ok: false, status: 401, code: "replayed_request" };
    }
    throw err;
  }

  const budget = await checkRateLimit(0, `wallet-calls:${keyId}`, WALLET_CALLS_PER_MINUTE, 60_000).catch(() => ({ allowed: true, justExceeded: false }));
  if (!budget.allowed) return { ok: false, status: 429, code: "rate_limited" };
  return { ok: true, keyId };
}
