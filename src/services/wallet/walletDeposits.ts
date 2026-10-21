import crypto from "node:crypto";
import type { Api } from "grammy";
import { getDb } from "../../db/connect.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { creditLedgerInSession } from "../../db/models/relic.js";
import { env } from "../../config/env.js";
import { createWalletTransfer, getWalletTransfer, walletConfigured, WalletApiError, type WalletTx } from "./walletClient.js";
import { isWalletIntegrationEnabled } from "./walletSettings.js";

/**
 * XP DEPOSIT FROM THE WALLET (Nava is the client; the Wallet never calls Nava).
 *
 *   createDeposit  → POST /transfers (idempotency key stored BEFORE the call, reused on every retry)
 *   syncDeposit    → GET  /transfers/{id}; ONLY status COMPLETED credits, exactly `amount` (never `total`)
 *   settle         → ONE MongoDB transaction: deposit row flips to completed + ledger row + balance. The ledger
 *                    id is derived from the Wallet transfer id, so even a parallel poll / cron / button press
 *                    cannot credit twice (second one sees the row and does nothing).
 *
 * The wallet token (PW-…) is kept on the row ONLY while the POST has not yet returned a transfer id (a retry needs
 * the same body); it is removed right after and only its last 4 chars stay. It cannot spend anything: the user must
 * still approve in the Wallet bot.
 */

export const DEPOSITS = "wallet_deposits";
export const TOKEN_RE = /^PW-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const WALLET_TTL_MS = 10 * 60_000; // the Wallet expires a request after 10 minutes
const GIVE_UP_CREATING_MS = 11 * 60_000;
const SWEEP_WINDOW_MS = 7 * 86_400_000;

export type DepositStatus = "creating" | "pending" | "completed" | "failed";

export interface DepositDoc {
  _id: string;
  userId: number;
  chatId: number;
  idempotencyKey: string;
  amount: number;
  tokenHint: string;
  walletToken?: string;
  status: DepositStatus;
  walletStatus?: string;
  txId?: string;
  fee?: number;
  total?: number;
  feePercent?: number;
  expiresAt?: Date;
  failureCode?: string;
  creditedAt?: Date;
  balanceAfter?: number;
  notifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastCheckAt?: Date;
}

async function col() {
  return (await getDb()).collection<DepositDoc>(DEPOSITS);
}

let indexed = false;
export async function ensureDepositIndexes() {
  if (indexed) return;
  const c = await col();
  await c.createIndexes([
    { key: { txId: 1 }, name: "txId_unique", unique: true, sparse: true },
    { key: { idempotencyKey: 1 }, name: "idem_unique", unique: true },
    { key: { userId: 1, createdAt: -1 }, name: "user_created" },
    { key: { status: 1, createdAt: 1 }, name: "status_created" },
  ]);
  indexed = true;
}

export function normalizeWalletToken(raw: string): string | null {
  const t = raw.trim().toUpperCase().replace(/[‐‑–—]/g, "-");
  return TOKEN_RE.test(t) ? t : null;
}

export function depositAvailable(): Promise<boolean> | boolean {
  if (!walletConfigured()) return false;
  return isWalletIntegrationEnabled();
}

/** What a user sees when the Wallet answers with an error code. */
export function describeWalletError(code: string): string {
  switch (code) {
    case "WALLET_USER_NOT_FOUND":
    case "INVALID_WALLET_TOKEN":
      return "توکن ولت پیدا نشد یا درست نیست. توکن رو دقیقاً از ربات ولت کپی کن (قالب PW-XXXX-XXXX-XXXX-XXXX).";
    case "INVALID_AMOUNT":
      return "این مقدار از طرف ولت پذیرفته نشد. یه عدد صحیح (بدون اعشار) وارد کن.";
    case "INSUFFICIENT_FUNDS":
      return "موجودی ولتت برای این مقدار + کارمزد کافی نیست.";
    case "INTEGRATION_DISABLED":
      return "اتصال به ولت فعلاً از سمت ولت غیرفعاله. بعداً دوباره امتحان کن.";
    case "USER_REJECTED":
      return "تو توی ولت انتقال رو رد کردی.";
    case "EXPIRED":
      return "مهلت ۱۰ دقیقه‌ای تأیید تموم شد. اگه هنوز می‌خوای، دوباره درخواست بده.";
    case "USER_UNREACHABLE":
      return "ربات ولت نتونست بهت پیام بده. ربات ولت رو باز کن (Start) و دوباره امتحان کن.";
    case "CLOSED_BY_ADMIN":
      return "این درخواست از سمت ولت بسته شد.";
    case "OWNER_ACCOUNT_MISSING":
      return "مشکل تنظیمات سمت ولت؛ به پشتیبانی خبر بده.";
    case "NETWORK":
    case "BAD_RESPONSE":
    case "NOT_CONFIGURED":
      return "الان ارتباط با ولت برقرار نشد. چند لحظه بعد دوباره امتحان کن.";
    default:
      return "ولت درخواست رو قبول نکرد. چند لحظه بعد دوباره امتحان کن.";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with retries on timeout/5xx/429 — always the SAME idempotency key, so it can never double-charge. */
async function postWithRetry(d: DepositDoc, token: string): Promise<WalletTx> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return (await createWalletTransfer({ idempotencyKey: d.idempotencyKey, externalUserId: String(d.userId), walletToken: token, amount: d.amount, note: `nava deposit ${d._id}` })).tx;
    } catch (err) {
      last = err;
      if (!(err instanceof WalletApiError) || !err.retryable) throw err;
      await sleep(Math.min(err.retryAfterMs ?? 600 * (i + 1), 3000));
    }
  }
  throw last;
}

function mapStatus(s: string): DepositStatus {
  return s === "COMPLETED" ? "completed" : s === "FAILED" ? "failed" : "pending";
}

async function applyTxSnapshot(d: DepositDoc, tx: WalletTx): Promise<void> {
  const c = await col();
  await c.updateOne(
    { _id: d._id, status: { $in: ["creating", "pending"] } },
    {
      $set: {
        txId: tx.id,
        walletStatus: tx.status,
        fee: tx.fee,
        total: tx.total,
        ...(typeof tx.fee_percent === "number" ? { feePercent: tx.fee_percent } : {}),
        ...(tx.expires_at ? { expiresAt: new Date(tx.expires_at) } : {}),
        status: tx.status === "FAILED" ? "failed" : "pending",
        ...(tx.status === "FAILED" ? { failureCode: tx.failure_code ?? "FAILED" } : {}),
        updatedAt: new Date(),
      },
      $unset: { walletToken: "" },
    },
  );
}

export type CreateResult = { ok: true; deposit: DepositDoc } | { ok: false; reason: "unavailable" | "bad_token" | "active_exists" | "wallet_error"; code?: string; deposit?: DepositDoc };

export async function createDeposit(p: { userId: number; chatId: number; rawToken: string; amount: number }): Promise<CreateResult> {
  if (!(await depositAvailable())) return { ok: false, reason: "unavailable" };
  const token = normalizeWalletToken(p.rawToken);
  if (!token) return { ok: false, reason: "bad_token" };
  await ensureDepositIndexes();
  const c = await col();
  const now = new Date();
  const active = await c.findOne({ userId: p.userId, status: { $in: ["creating", "pending"] }, createdAt: { $gt: new Date(now.getTime() - GIVE_UP_CREATING_MS) } });
  if (active) return { ok: false, reason: "active_exists", deposit: active };

  const d: DepositDoc = {
    _id: crypto.randomUUID(),
    userId: p.userId,
    chatId: p.chatId,
    idempotencyKey: `nava-${p.userId}-${crypto.randomBytes(8).toString("hex")}`, // stored BEFORE the call
    amount: p.amount,
    tokenHint: token.slice(-4),
    walletToken: token,
    status: "creating",
    createdAt: now,
    updatedAt: now,
  };
  await c.insertOne(d as any);
  try {
    const tx = await postWithRetry(d, token);
    await applyTxSnapshot(d, tx);
  } catch (err) {
    const code = err instanceof WalletApiError ? err.code : "NETWORK";
    if (err instanceof WalletApiError && err.retryable) {
      // uncertain (timeout / 5xx): the request may exist on the Wallet side. Keep the row; a later sync re-POSTs with the SAME key.
      return { ok: false, reason: "wallet_error", code, deposit: (await c.findOne({ _id: d._id })) ?? d };
    }
    await c.updateOne({ _id: d._id }, { $set: { status: "failed", failureCode: code, updatedAt: new Date() }, $unset: { walletToken: "" } });
    return { ok: false, reason: "wallet_error", code };
  }
  return { ok: true, deposit: (await c.findOne({ _id: d._id }))! };
}

export type SettleResult = { credited: boolean; balanceAfter?: number };

/** Credit exactly once. `tx` must be the COMPLETED transaction read from the Wallet. */
async function settleCompleted(d: DepositDoc, tx: WalletTx): Promise<SettleResult> {
  const c = await col();
  const db = await getDb();
  const ledgerId = `walletdep:${tx.id}`;
  try {
    return await runInTransaction(async (s) => {
      const flipped = await c.updateOne(
        { _id: d._id, status: { $ne: "completed" } },
        { $set: { status: "completed", walletStatus: "COMPLETED", txId: tx.id, fee: tx.fee, total: tx.total, creditedAt: new Date(), updatedAt: new Date() }, $unset: { walletToken: "" } },
        { session: s },
      );
      if (flipped.modifiedCount !== 1) throw new TxAbort("already_settled");
      const credited = await creditLedgerInSession(ledgerId, d.userId, d.amount, "WALLET_TRANSFER", s, {
        reference: tx.id,
        metadata: { depositId: d._id, fee: tx.fee, total: tx.total },
      });
      if (!credited) throw new TxAbort("ledger_exists");
      const u: any = await db.collection<any>("users").findOne({ _id: d.userId }, { session: s, projection: { relicBalance: 1 } });
      await c.updateOne({ _id: d._id }, { $set: { balanceAfter: u?.relicBalance ?? 0 } }, { session: s });
      return { credited: true, balanceAfter: u?.relicBalance ?? 0 };
    });
  } catch (err: any) {
    if (err instanceof TxAbort || err?.code === 11000) return { credited: false };
    if (/credit target .* does not exist/.test(String(err?.message))) {
      // the account was removed (e.g. reset) while the Wallet side finished: money is NOT lost silently — flag it for the owner
      await c.updateOne({ _id: d._id }, { $set: { status: "pending", failureCode: "NAVA_USER_MISSING", updatedAt: new Date() } });
      return { credited: false };
    }
    throw err;
  }
}

/** Sanity check: the Wallet's answer must describe THIS deposit. */
function matches(d: DepositDoc, tx: WalletTx): boolean {
  return (!d.txId || tx.id === d.txId) && tx.amount === d.amount && (tx.external_user_id === undefined || tx.external_user_id === String(d.userId));
}

export interface SyncOutcome {
  deposit: DepositDoc;
  credited: boolean;
  balanceAfter?: number;
  mismatch?: boolean;
}

export async function syncDeposit(id: string): Promise<SyncOutcome | null> {
  const c = await col();
  let d = await c.findOne({ _id: id });
  if (!d) return null;
  if (d.status === "completed" || d.status === "failed") return { deposit: d, credited: false };
  const now = Date.now();

  if (d.status === "creating") {
    if (now - d.createdAt.getTime() > GIVE_UP_CREATING_MS || !d.walletToken) {
      await c.updateOne({ _id: d._id, status: "creating" }, { $set: { status: "failed", failureCode: "EXPIRED", updatedAt: new Date() }, $unset: { walletToken: "" } });
      return { deposit: (await c.findOne({ _id: id }))!, credited: false };
    }
    try {
      await applyTxSnapshot(d, await postWithRetry(d, d.walletToken)); // same key → replay, never a second charge
    } catch (err) {
      if (err instanceof WalletApiError && !err.retryable) {
        await c.updateOne({ _id: d._id }, { $set: { status: "failed", failureCode: err.code, updatedAt: new Date() }, $unset: { walletToken: "" } });
      }
      return { deposit: (await c.findOne({ _id: id }))!, credited: false };
    }
    d = (await c.findOne({ _id: id }))!;
    if (d.status !== "pending") return { deposit: d, credited: false };
  }

  if (!d.txId) return { deposit: d, credited: false };
  let tx: WalletTx;
  try {
    tx = (await getWalletTransfer(d.txId)).tx;
  } catch {
    await c.updateOne({ _id: d._id }, { $set: { lastCheckAt: new Date() } });
    return { deposit: d, credited: false }; // transient: keep polling later
  }
  if (!matches(d, tx)) {
    await c.updateOne({ _id: d._id }, { $set: { status: "failed", failureCode: "MISMATCH", updatedAt: new Date() } });
    return { deposit: (await c.findOne({ _id: id }))!, credited: false, mismatch: true };
  }
  if (tx.status === "COMPLETED") {
    const r = await settleCompleted(d, tx);
    return { deposit: (await c.findOne({ _id: id }))!, credited: r.credited, balanceAfter: r.balanceAfter };
  }
  await c.updateOne(
    { _id: d._id, status: "pending" },
    { $set: { walletStatus: tx.status, lastCheckAt: new Date(), updatedAt: new Date(), ...(tx.status === "FAILED" ? { status: "failed", failureCode: tx.failure_code ?? "FAILED" } : {}) } },
  );
  return { deposit: (await c.findOne({ _id: id }))!, credited: false };
}

/** Poll every `stepMs` for at most `maxMs` (used right after creating a request, while the user approves in the Wallet bot). */
export async function pollDeposit(id: string, maxMs = 18_000, stepMs = 3_000): Promise<SyncOutcome | null> {
  const end = Date.now() + maxMs;
  let out = await syncDeposit(id);
  while (out && out.deposit.status === "pending" && Date.now() + stepMs < end) {
    await sleep(stepMs);
    out = await syncDeposit(id);
  }
  return out;
}

export async function activeDepositOf(userId: number): Promise<DepositDoc | null> {
  return (await col()).findOne({ userId, status: { $in: ["creating", "pending"] } } as any, { sort: { createdAt: -1 } } as any);
}

export function creditedMessage(o: SyncOutcome): string {
  const d = o.deposit;
  return `✅ <b>واریز انجام شد</b>\n\n${d.amount} XP به حساب نوات اضافه شد.` + (d.fee ? `\n(کارمزد ${d.fee} XP فقط از ولتت کم شده؛ مجموع کسر از ولت: ${d.total})` : "") + (o.balanceAfter !== undefined ? `\nموجودی فعلی: ${o.balanceAfter} XP` : "");
}

/** Tells the user (once) how a deposit that finished while they were away ended. */
export async function notifyOutcome(api: Api, o: SyncOutcome): Promise<void> {
  const d = o.deposit;
  const c = await col();
  if (d.notifiedAt) return;
  let text: string | null = null;
  if (o.credited) text = creditedMessage(o);
  else if (d.status === "failed") text = `❌ <b>واریز انجام نشد</b>\n${describeWalletError(d.failureCode ?? "")}\nهیچ XP‌ای از ولت یا نوا کم/زیاد نشد.`;
  if (!text) return;
  const claim = await c.updateOne({ _id: d._id, notifiedAt: { $exists: false } } as any, { $set: { notifiedAt: new Date() } });
  if (claim.modifiedCount !== 1) return;
  await api.sendMessage(d.chatId, text, { parse_mode: "HTML" }).catch(() => {});
}

/** Cron / manual sweep: finish every deposit still waiting (so XP lands even if the user never comes back). */
export async function sweepPendingDeposits(api: Api, limit = 50): Promise<{ checked: number; credited: number; failed: number }> {
  if (!walletConfigured()) return { checked: 0, credited: 0, failed: 0 };
  const c = await col();
  const rows = await c.find({ status: { $in: ["creating", "pending"] }, createdAt: { $gt: new Date(Date.now() - SWEEP_WINDOW_MS) } } as any).limit(limit).toArray();
  let credited = 0, failed = 0;
  for (const r of rows) {
    const o = await syncDeposit(r._id).catch(() => null);
    if (!o) continue;
    if (o.credited) credited++;
    if (o.deposit.status === "failed") failed++;
    if (o.mismatch) await alertOwner(api, `⚠️ ولت: پاسخ ولت با واریز ${r._id} نمی‌خواند؛ XP داده نشد. بررسی دستی لازم است.`);
    await notifyOutcome(api, o).catch(() => {});
  }
  return { checked: rows.length, credited, failed };
}

async function alertOwner(api: Api, text: string) {
  if (env.OWNER_ID) await api.sendMessage(env.OWNER_ID, text).catch(() => {});
}
