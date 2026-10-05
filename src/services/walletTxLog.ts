import { Api } from "grammy";
import { env } from "../config/env.js";
import { getSettings, ledgerCol, type WalletLedgerDoc } from "../db/models/walletCore.js";

/** Public transaction log: every ledger row is posted (once per state change) to the owner's
 *  "transactions" channel (set from the wallet admin panel, never env). */
const KIND_FA: Record<string, string> = {
  mining: "⛏ ماین", signup_bonus: "🎁 پاداش ثبت‌نام", task_reward: "✅ پاداش تسک", purchase_credit: "🛒 خرید / شارژ",
  admin_topup: "💎 شارژ مالک", transfer: "↔️ انتقال ولت به ولت", to_nava: "➡️ انتقال به ربات نوا", to_partner: "➡️ انتقال به ربات دیگر",
  from_partner: "⬅️ دریافت از ربات دیگر", recovery: "🔐 بازیابی ولت", refund: "↩️ بازگشت وجه",
};
const STATUS_FA: Record<string, string> = { completed: "✅ موفق", pending: "⏳ در انتظار تحویل", failed: "❌ ناموفق", refunded: "↩️ برگشت‌خورده" };

export function formatTx(r: WalletLedgerDoc): string {
  const lines = [
    `🧾 تراکنش ${r._id.slice(0, 40)}`,
    `نوع: ${KIND_FA[r.kind] ?? r.kind}`,
    `مقدار: ${r.amount} رلیک${r.fee ? ` (کارمزد ${r.fee})` : ""}`,
    `فرستنده: ${r.fromName ? `${r.fromName} ` : ""}[${r.from}]`,
    `دریافت‌کننده: ${r.toName ? `${r.toName} ` : ""}[${r.to}]`,
    `وضعیت: ${STATUS_FA[r.status] ?? r.status}`,
  ];
  if (r.note) lines.push(`توضیح: ${r.note}`);
  lines.push(`زمان: ${r.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC`);
  return lines.join("\n");
}

export type TxSender = (chatId: number, text: string) => Promise<void>;
let sender: TxSender = async (chatId, text) => {
  const token = env.WALLET_BOT_TOKEN;
  if (!token) throw new Error("no wallet bot token");
  await new Api(token).sendMessage(chatId, text);
};
export function setTxSender(s: TxSender | null) {
  if (s) sender = s;
}

/** Posts unlogged rows (oldest first). Never throws; a failed send leaves the row unlogged for the next sweep. */
export async function flushTxLog(limit = 20): Promise<number> {
  try {
    const s = await getSettings();
    if (!s.txLogChatId) return 0;
    const led = await ledgerCol();
    const filter: any = { logged: false };
    if (s.txLogSince) filter.createdAt = { $gte: s.txLogSince };
    const rows = await led.find(filter).sort({ createdAt: 1 }).limit(limit).toArray();
    let sent = 0;
    for (const r of rows) {
      // claim first so two concurrent flushers never post the same row twice
      const claimed = await led.updateOne({ _id: r._id, logged: false }, { $set: { logged: true } });
      if (claimed.matchedCount !== 1) continue;
      try {
        await sender(s.txLogChatId, formatTx(r));
        sent++;
      } catch (err) {
        await led.updateOne({ _id: r._id }, { $set: { logged: false } });
        console.error("[wallet] tx log send failed:", err instanceof Error ? err.name : "unknown");
        break;
      }
    }
    return sent;
  } catch (err) {
    console.error("[wallet] tx log flush failed:", err instanceof Error ? err.name : "unknown");
    return 0;
  }
}
