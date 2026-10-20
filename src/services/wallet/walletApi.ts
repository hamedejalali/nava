import { checkRateLimit, peekRateLimit } from "../../utils/rateLimit.js";
import { authenticateWalletRequest, auditWallet, ensureWalletIndexes, type WalletRequestInfo } from "./walletAuth.js";
import { creditXpFromWallet, describeRecipient, getTransferStatus, type CreditError } from "./xpCredit.js";
import { ensureTransferTokenIndexes } from "./transferToken.js";

/**
 * Transport-independent handler of the Wallet -> Nava API (api/wallet.ts is a thin shell around it).
 * Always answers `{ ok: true, ... }` or `{ ok: false, error: { code, message } }` — never a stack trace,
 * a secret, or a database detail.
 *
 *   POST /api/wallet/v1/resolve  { userToken }                                         -> who would be credited
 *   POST /api/wallet/v1/credit   { transactionId, idempotencyKey, userToken, amount,
 *                                  walletFee?, reference? }                            -> credit `amount` XP, once
 *   POST /api/wallet/v1/status   { transactionId }                                     -> did it go through?
 */

export const WALLET_OPS = ["resolve", "credit", "status"] as const;
export type WalletOp = (typeof WALLET_OPS)[number];
export const MAX_BODY_BYTES = 4096;
export const BAD_TOKEN_LIMIT = 10; // per 5 minutes, per integration: stops anybody guessing tokens through a leaked secret

export interface WalletApiDeps {
  /** best-effort Telegram notices; failures must never change the API result */
  notifyUser?: (userId: number, text: string) => Promise<void>;
  notifyOwner?: (text: string) => Promise<void>;
}

export interface WalletApiResult {
  status: number;
  body: Record<string, unknown>;
}

const MESSAGES: Record<string, string> = {
  integration_not_configured: "The integration is not configured.",
  integration_disabled: "The integration is switched off.",
  missing_auth_headers: "Authentication headers are missing.",
  invalid_credentials: "Invalid credentials.",
  invalid_timestamp: "Invalid timestamp.",
  timestamp_out_of_window: "Timestamp is outside the accepted window.",
  invalid_nonce: "Invalid nonce.",
  invalid_signature: "Invalid signature.",
  replayed_request: "This request was already used (nonce replay).",
  too_many_failures: "Too many failed attempts. Try again later.",
  rate_limited: "Too many requests.",
  too_many_invalid_tokens: "Too many invalid tokens. Try again later.",
  method_not_allowed: "Use POST.",
  not_found: "Unknown endpoint.",
  payload_too_large: "Body too large.",
  invalid_json: "Body must be a JSON object.",
  invalid_request: "A field is missing or malformed.",
  invalid_amount: "amount must be a positive whole number of XP (1..1000000000).",
  invalid_token: "The user token is not valid.",
  token_revoked: "The user token was revoked or replaced.",
  user_unavailable: "The recipient cannot receive XP right now.",
  transaction_conflict: "transactionId was already used with different data.",
  idempotency_conflict: "idempotencyKey was already used with a different transaction.",
  server_error: "Internal error. Check the transaction status before retrying.",
};

const STATUS_OF: Record<string, number> = {
  integration_not_configured: 503, integration_disabled: 403, missing_auth_headers: 401, invalid_credentials: 401, invalid_timestamp: 401,
  timestamp_out_of_window: 401, invalid_nonce: 401, invalid_signature: 401, replayed_request: 401, too_many_failures: 429, rate_limited: 429,
  too_many_invalid_tokens: 429, method_not_allowed: 405, not_found: 404, payload_too_large: 413, invalid_json: 400, invalid_request: 400,
  invalid_amount: 400, invalid_token: 404, token_revoked: 410, user_unavailable: 403, transaction_conflict: 409, idempotency_conflict: 409, server_error: 500,
};

function err(code: string, extra: Record<string, unknown> = {}): WalletApiResult {
  return { status: STATUS_OF[code] ?? 400, body: { ok: false, error: { code, message: MESSAGES[code] ?? "Error.", ...extra } } };
}

export interface WalletHttpRequest {
  method: string;
  op: string;
  rawBody: string;
  headers: WalletRequestInfo["headers"];
  ip: string;
  nowMs?: number;
}

export async function handleWalletRequest(req: WalletHttpRequest, deps: WalletApiDeps = {}): Promise<WalletApiResult> {
  const op = req.op;
  try {
    if (!(WALLET_OPS as readonly string[]).includes(op)) return err("not_found");
    if (req.method !== "POST") return err("method_not_allowed");
    if (Buffer.byteLength(req.rawBody, "utf8") > MAX_BODY_BYTES) return err("payload_too_large");

    await ensureWalletIndexes();
    await ensureTransferTokenIndexes();

    const auth = await authenticateWalletRequest({ method: req.method, path: `/api/wallet/v1/${op}`, rawBody: req.rawBody, headers: req.headers, ip: req.ip, nowMs: req.nowMs }, op);
    if (!auth.ok) {
      if (auth.alert) void deps.notifyOwner?.("⚠️ تلاش‌های ناموفق مکرر برای اتصال ولت (XP) شناسایی شد. در صورت لزوم از پنل «اتصال ولت» اتصال را خاموش کن و کلید را عوض کن.").catch(() => {});
      return err(auth.code);
    }

    let body: any;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return err("invalid_json");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return err("invalid_json");

    if (op === "status") {
      const r = await getTransferStatus(body.transactionId);
      if (!r.ok) return err("invalid_request", { field: "transactionId" });
      return { status: 200, body: r.found ? { ok: true, found: true, transfer: r.transfer } : { ok: true, found: false } };
    }

    // resolve / credit both look a user token up: block guessing after too many misses
    const badTokenBucket = `wallet-badtoken:${auth.keyId}`;
    if ((await peekRateLimit(0, badTokenBucket, 5 * 60_000)) >= BAD_TOKEN_LIMIT && op === "resolve") return err("too_many_invalid_tokens");
    const noteBadToken = async () => {
      const r = await checkRateLimit(0, badTokenBucket, BAD_TOKEN_LIMIT, 5 * 60_000).catch(() => null);
      if (r?.justExceeded) void deps.notifyOwner?.("⚠️ چند توکن نامعتبر پشت‌سرهم از طرف ولت آمد (احتمال حدس‌زدن توکن). اتصال موقتاً برای توکن‌های جدید مسدود شد.").catch(() => {});
    };

    if (op === "resolve") {
      const r = await describeRecipient(body.userToken);
      if (!r.ok) {
        if (r.error === "invalid_token") await noteBadToken();
        await auditWallet({ op, code: r.error, keyId: auth.keyId, ip: req.ip });
        return err(r.error);
      }
      return { status: 200, body: { ok: true, recipient: r.recipient } };
    }

    // credit
    if ((await peekRateLimit(0, badTokenBucket, 5 * 60_000)) >= BAD_TOKEN_LIMIT) {
      // a retry of an ALREADY completed transfer must still be answerable, so only brand-new ids are blocked
      const known = await getTransferStatus(body.transactionId);
      if (!(known.ok && known.found)) return err("too_many_invalid_tokens");
    }
    const r = await creditXpFromWallet({ keyId: auth.keyId, transactionId: body.transactionId, idempotencyKey: body.idempotencyKey, userToken: body.userToken, amount: body.amount, walletFee: body.walletFee, reference: body.reference });
    if (!r.ok) {
      if (r.error === "invalid_token") await noteBadToken();
      await auditWallet({ op, code: r.error, keyId: auth.keyId, ip: req.ip, transactionId: typeof body.transactionId === "string" ? body.transactionId : undefined });
      return err(r.error as CreditError, r.field ? { field: r.field } : r.amountError ? { reason: r.amountError } : {});
    }
    await auditWallet({ op, code: r.duplicate ? "duplicate_ok" : "credited", keyId: auth.keyId, transactionId: r.transfer.transactionId, userId: r.userId, amount: r.transfer.amount });
    if (!r.duplicate && deps.notifyUser) {
      // only after the credit is committed; a failed notice never changes the result
      await deps.notifyUser(r.userId, `✅ ${r.transfer.amount} XP از ولت به حساب نوای تو اضافه شد.`).catch(() => {});
    }
    return { status: 200, body: { ok: true, duplicate: r.duplicate, transfer: r.transfer } };
  } catch (e) {
    console.error("[wallet-api] failed:", e instanceof Error ? e.name : "unknown");
    await auditWallet({ op, code: "server_error", ip: req.ip });
    return err("server_error");
  }
}
