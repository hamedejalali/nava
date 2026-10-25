import type { Api } from "grammy";
import { getDb } from "../../db/connect.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { creditLedgerInSession } from "../../db/models/relic.js";
import { env } from "../../config/env.js";
import { listCompletedTransfers, requestDepositCode, walletConfigured, WalletApiError, type WalletTx } from "./walletClient.js";
import { isWalletIntegrationEnabled } from "./walletSettings.js";
import { MAX_XP_AMOUNT } from "./xpAmount.js";
import { getLogChatId } from "../channelRouting.js";

/**
 * ژتون DEPOSITS FROM THE WALLET — Flow A («آدرس واریز»). Nava is only a client of the Wallet API.
 *
 *   1. getDepositAddress(userId)   → POST /deposit-codes (fixed per user; cached here, the Wallet stays the source of truth)
 *   2. syncWalletDeposits()        → GET  /transfers?status=COMPLETED&completed_after=<cursor>&limit=100
 *   3. creditTransfer(tx)          → ONE MongoDB transaction: insert wallet_deposits{_id: tx.id} (unique) + ledger + balance.
 *                                    A transaction id that was already stored is a no-op, so a repeated poll, a parallel cron
 *                                    run or a re-delivered webhook can never credit twice.
 *
 * Rules that never bend: only status COMPLETED credits; the credited amount is `delivered_amount` (net of the fee), never
 * `amount`/`total`; nothing is ever credited because of something the user typed.
 */

export const DEPOSITS = "wallet_deposits";
const ADDRESSES = "wallet_addresses";
const SYNC = "wallet_sync";
const UNMATCHED = "wallet_unmatched";
const CURSOR_ID = "cursor";
const PAGE = 100;
const MAX_PAGES = 10;

export interface DepositRow {
  _id: string; // Wallet transaction id
  flow: "A";
  userId: number;
  amount: number; // credited ژتون (= delivered_amount)
  fee?: number;
  totalCharged?: number;
  walletCompletedAt?: string;
  creditedAt: Date;
  balanceAfter?: number;
  notifiedAt?: Date;
}

interface SyncDoc {
  _id: typeof CURSOR_ID;
  completedAfter?: string;
  lastRunAt?: Date;
  lastOkAt?: Date;
  lastError?: string;
  lastErrorAt?: Date;
  lockUntil?: Date;
  alertedAuthAt?: Date;
}

async function db() {
  return getDb();
}

let indexed = false;
export async function ensureWalletIndexes() {
  if (indexed) return;
  const d = await db();
  await d.collection(ADDRESSES).createIndexes([{ key: { address: 1 }, name: "address_unique", unique: true }]);
  await d.collection(DEPOSITS).createIndexes([
    { key: { userId: 1, creditedAt: -1 }, name: "user_credited" },
    { key: { creditedAt: -1 }, name: "credited" },
  ]);
  indexed = true;
}

export function depositAvailable(): Promise<boolean> | boolean {
  if (!walletConfigured()) return false;
  return isWalletIntegrationEnabled();
}

/** What the user/admin can be told about a wallet API error. */
export function describeWalletError(code: string): string {
  switch (code) {
    case "INTEGRATION_DISABLED":
      return "اتصال به ولت فعلاً از سمت ولت غیرفعاله. بعداً دوباره امتحان کن.";
    case "UNAUTHORIZED":
    case "STALE_TIMESTAMP":
    case "REPLAYED_REQUEST":
      return "مشکل احراز هویت اتصال ولت؛ به پشتیبانی خبر بده.";
    case "NOT_CONFIGURED":
      return "اتصال ولت هنوز تنظیم نشده.";
    default:
      return "الان ارتباط با ولت برقرار نشد. چند لحظه بعد دوباره امتحان کن.";
  }
}

// ---------------------------------------------------------------- 1) address

export type AddressResult = { ok: true; address: string } | { ok: false; reason: "unavailable" | "wallet_error"; code?: string };

export async function getDepositAddress(userId: number): Promise<AddressResult> {
  if (!(await depositAvailable())) return { ok: false, reason: "unavailable" };
  await ensureWalletIndexes();
  const col = (await db()).collection<{ _id: number; address: string; createdAt: Date }>(ADDRESSES);
  const cached = await col.findOne({ _id: userId });
  if (cached) return { ok: true, address: cached.address };
  try {
    const dc = await requestDepositCode(String(userId));
    await col.updateOne({ _id: userId }, { $setOnInsert: { address: dc.address, createdAt: new Date() } }, { upsert: true });
    const row = await col.findOne({ _id: userId });
    return { ok: true, address: row?.address ?? dc.address };
  } catch (err: any) {
    // a duplicate address on two users must never be cached: the Wallet guarantees uniqueness, so this is a data problem to look at
    return { ok: false, reason: "wallet_error", code: err instanceof WalletApiError ? err.code : err?.code === 11000 ? "DUPLICATE_ADDRESS" : "NETWORK" };
  }
}

// ---------------------------------------------------------------- 3) credit exactly once

export type CreditOutcome = { credited: false; reason: "duplicate" | "invalid" | "user_missing" | "not_completed" } | { credited: true; userId: number; amount: number; balanceAfter: number; row: DepositRow };

export async function creditTransfer(tx: WalletTx): Promise<CreditOutcome> {
  if (tx.status !== "COMPLETED") return { credited: false, reason: "not_completed" };
  const userId = Number(tx.external_user_id);
  const amount = tx.delivered_amount;
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_XP_AMOUNT) {
    await recordUnmatched(tx, "invalid");
    return { credited: false, reason: "invalid" };
  }
  await ensureWalletIndexes();
  const d = await db();
  const row: DepositRow = {
    _id: tx.id,
    flow: "A",
    userId,
    amount: amount as number,
    ...(typeof tx.fee === "number" ? { fee: tx.fee } : {}),
    ...(typeof tx.total_charged === "number" ? { totalCharged: tx.total_charged } : {}),
    ...(tx.completed_at ? { walletCompletedAt: tx.completed_at } : {}),
    creditedAt: new Date(),
  };
  try {
    const balanceAfter = await runInTransaction(async (s) => {
      const ins = await d.collection<any>(DEPOSITS).updateOne({ _id: tx.id }, { $setOnInsert: row }, { upsert: true, session: s });
      if (ins.upsertedCount !== 1) throw new TxAbort("duplicate");
      const ok = await creditLedgerInSession(`walletdep:${tx.id}`, userId, amount as number, "WALLET_TRANSFER", s, {
        reference: tx.id,
        metadata: { fee: tx.fee ?? null, totalCharged: tx.total_charged ?? null, flow: "A" },
      });
      if (!ok) throw new TxAbort("duplicate");
      const u: any = await d.collection<any>("users").findOne({ _id: userId as never }, { session: s, projection: { relicBalance: 1 } });
      const bal = u?.relicBalance ?? 0;
      await d.collection<any>(DEPOSITS).updateOne({ _id: tx.id }, { $set: { balanceAfter: bal } }, { session: s });
      return bal as number;
    });
    return { credited: true, userId, amount: amount as number, balanceAfter, row: { ...row, balanceAfter } };
  } catch (err: any) {
    if (err instanceof TxAbort || err?.code === 11000) return { credited: false, reason: "duplicate" };
    if (/credit target .* does not exist/.test(String(err?.message))) {
      await recordUnmatched(tx, "user_missing"); // the money is NOT lost silently: the owner is told
      return { credited: false, reason: "user_missing" };
    }
    throw err;
  }
}

async function recordUnmatched(tx: WalletTx, reason: string) {
  await (await db()).collection<any>(UNMATCHED).updateOne({ _id: tx.id }, { $setOnInsert: { reason, externalUserId: tx.external_user_id ?? null, deliveredAmount: tx.delivered_amount ?? null, createdAt: new Date() } }, { upsert: true });
}

// ---------------------------------------------------------------- 2) polling

export interface SyncSummary {
  ran: boolean;
  fetched: number;
  credited: number;
  error?: string;
}

const syncCol = async () => (await db()).collection<SyncDoc>(SYNC);

/** Notifies the user (once) and writes a receipt to the log chat. Never throws. */
export async function announceCredit(api: Pick<Api, "sendMessage">, o: Extract<CreditOutcome, { credited: true }>): Promise<void> {
  const d = await db();
  const claim = await d.collection<any>(DEPOSITS).updateOne({ _id: o.row._id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: new Date() } });
  if (claim.modifiedCount !== 1) return;
  await api.sendMessage(o.userId, `✅ ${o.amount} ژتون به حساب شما در نوا اضافه شد.`).catch(() => {});
  const logChat = await getLogChatId("wallet").catch(() => undefined);
  if (logChat !== undefined) {
    const lines = [
      "🧾 <b>رسید واریز از ولت</b>",
      `تراکنش ولت: <code>${o.row._id}</code>`,
      `کاربر: <code>${o.userId}</code>`,
      `مبلغ واریزی به نوا: ${o.amount} ژتون`,
      ...(o.row.fee !== undefined ? [`کارمزد: ${o.row.fee} ژتون`] : []),
      ...(o.row.totalCharged !== undefined ? [`کسر شده از ولت کاربر: ${o.row.totalCharged} ژتون`] : []),
      `زمان: ${o.row.walletCompletedAt ?? o.row.creditedAt.toISOString()}`,
    ];
    await api.sendMessage(logChat, lines.join("\n"), { parse_mode: "HTML" }).catch(() => {});
  }
}

async function alertAdmins(api: Pick<Api, "sendMessage">, text: string) {
  if (env.OWNER_ID) await api.sendMessage(env.OWNER_ID, text).catch(() => {});
}

/**
 * Fetches every COMPLETED transfer after the stored cursor and credits it. Safe to call from anywhere, any number of times
 * (a short lock keeps parallel serverless instances from doing the same page twice — and even without it the unique
 * transaction id makes a double credit impossible).
 */
export async function syncWalletDeposits(api: Pick<Api, "sendMessage">, opts: { force?: boolean } = {}): Promise<SyncSummary> {
  if (!(await depositAvailable())) return { ran: false, fetched: 0, credited: 0 };
  const c = await syncCol();
  const now = new Date();
  await c.updateOne({ _id: CURSOR_ID }, { $setOnInsert: { lastRunAt: now } }, { upsert: true });
  if (!opts.force) {
    const lock = await c.findOneAndUpdate(
      { _id: CURSOR_ID, $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lt: now } }] },
      { $set: { lockUntil: new Date(now.getTime() + 20_000), lastRunAt: now } },
    );
    if (!lock) return { ran: false, fetched: 0, credited: 0 }; // another instance is already doing this page
  }
  let cursor = (await c.findOne({ _id: CURSOR_ID }))?.completedAfter;
  let fetched = 0;
  let credited = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = await listCompletedTransfers({ completedAfter: cursor, limit: PAGE });
      fetched += list.length;
      for (const tx of list) {
        const out = await creditTransfer(tx);
        if (out.credited) {
          credited++;
          await announceCredit(api, out);
        } else if (out.reason === "user_missing" || out.reason === "invalid") {
          await alertAdmins(api, `⚠️ واریز ولت ${tx.id} به هیچ کاربر معتبری در نوا نخورد (${out.reason}). مبلغ: ${tx.delivered_amount ?? "?"}. بررسی دستی لازم است.`);
        }
      }
      const last = list[list.length - 1];
      const newest = last?.completed_at;
      if (newest && (!cursor || newest >= cursor)) {
        cursor = newest;
        await c.updateOne({ _id: CURSOR_ID }, { $set: { completedAfter: cursor } }, { upsert: true });
      }
      // the filter is inclusive: a page that only repeats the last item means we are done
      if (list.length < PAGE) break;
    }
    await c.updateOne({ _id: CURSOR_ID }, { $set: { lastOkAt: new Date() }, $unset: { lastError: "", lockUntil: "" } }, { upsert: true });
    return { ran: true, fetched, credited };
  } catch (err: any) {
    const code = err instanceof WalletApiError ? err.code : "ERROR";
    await c.updateOne({ _id: CURSOR_ID }, { $set: { lastError: code, lastErrorAt: new Date() }, $unset: { lockUntil: "" } }, { upsert: true });
    // wrong id / key (401): tell the owner, at most once per hour. timeouts / 5xx are not failures: the next run asks again.
    if (err instanceof WalletApiError && err.status === 401) {
      const doc = await c.findOne({ _id: CURSOR_ID });
      if (!doc?.alertedAuthAt || Date.now() - doc.alertedAuthAt.getTime() > 3_600_000) {
        await c.updateOne({ _id: CURSOR_ID }, { $set: { alertedAuthAt: new Date() } });
        await alertAdmins(api, `⚠️ اتصال ولت: احراز هویت رد شد (${code}). WALLET_INTEGRATION_ID و WALLET_API_SECRET را بررسی کن.`);
      }
    }
    return { ran: true, fetched, credited, error: code };
  }
}

/** Opportunistic sync for the webhook (at most once per `minGapMs` per warm instance; the DB lock covers the rest). */
let lastAuto = 0;
export async function maybeSyncWalletDeposits(api: Pick<Api, "sendMessage">, minGapMs = 60_000): Promise<void> {
  const t = Date.now();
  if (t - lastAuto < minGapMs) return;
  lastAuto = t;
  if (!walletConfigured()) return;
  await syncWalletDeposits(api).catch(() => {});
}

/** While the user looks at the deposit screen: ask every `stepMs` for up to `maxMs`, stop at the first credit for them. */
export async function watchUserDeposit(api: Pick<Api, "sendMessage">, userId: number, maxMs = 45_000, stepMs = 5_000): Promise<number> {
  const end = Date.now() + maxMs;
  let credited = 0;
  while (Date.now() < end) {
    const r = await syncWalletDeposits(api, { force: true }).catch(() => null);
    credited += r?.credited ?? 0;
    if (credited > 0) break;
    await new Promise((res) => setTimeout(res, stepMs));
  }
  return credited;
}

// ---------------------------------------------------------------- admin view

export async function walletStats() {
  const d = await db();
  const since = new Date(Date.now() - 86_400_000);
  const dep = d.collection<DepositRow>(DEPOSITS);
  const [last24, recent, sync] = await Promise.all([
    dep.find({ creditedAt: { $gte: since } }).toArray(),
    dep.find({}).sort({ creditedAt: -1 }).limit(10).toArray(),
    (await syncCol()).findOne({ _id: CURSOR_ID }),
  ]);
  return { count24h: last24.length, sum24h: last24.reduce((a, r) => a + r.amount, 0), recent, sync };
}
