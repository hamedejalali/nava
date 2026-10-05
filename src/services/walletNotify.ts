import { Api } from "grammy";
import { env } from "../config/env.js";
import { ledgerCol, type WalletLedgerDoc } from "../db/models/walletCore.js";

/**
 * Tracking-code notifications. Both parties of a transfer get a private message that carries the
 * tracking code (کد پیگیری); the owner pastes that code in the wallet admin panel to see exactly
 * what happened. Sent at most once per ledger status (completed / pending / refunded), best-effort:
 * a blocked bot or Telegram outage never affects money movement.
 */
export type NotifyBot = "wallet" | "nava";
export type NotifySender = (bot: NotifyBot, chatId: number, text: string) => Promise<void>;
let sender: NotifySender = async (bot, chatId, text) => {
  const token = bot === "wallet" ? env.WALLET_BOT_TOKEN : env.BOT_TOKEN;
  if (!token) throw new Error("no token");
  await new Api(token).sendMessage(chatId, text);
};
export function setNotifySender(s: NotifySender | null) {
  if (s) sender = s;
}

const withTimeout = <T>(p: Promise<T>, ms = 4000) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

const STATUS_FA: Record<string, string> = { completed: "✅ موفق", pending: "⏳ در انتظار تحویل", refunded: "↩️ برگشت‌خورده" };

function messages(row: WalletLedgerDoc, refundCode?: string): { sender?: string; receiver?: string; receiverBot?: NotifyBot } {
  const code = row.code ?? "-";
  const foot = `\n\n🔎 کد پیگیری: ${code}`;
  const amt = `${row.amount} رلیک`;
  if (row.kind === "transfer" || row.kind === "to_nava") {
    return {
      sender: `📤 ارسال ${amt} به ${row.toName ?? "گیرنده"}${row.fee ? ` (کارمزد ${row.fee})` : ""}\nوضعیت: ${STATUS_FA[row.status] ?? row.status}${foot}`,
      receiver: `📥 ${amt} از طرف ${row.fromName ?? "یک کاربر"} به شما رسید${foot}`,
      receiverBot: row.kind === "transfer" ? "wallet" : "nava",
    };
  }
  if (row.kind === "to_partner") {
    if (row.status === "refunded") {
      return { sender: `↩️ ارسال ${amt} به ${row.toName ?? "ربات مقصد"} انجام نشد و مبلغ کامل (با کارمزد) به ولتت برگشت.${foot}${refundCode ? `\nکد پیگیری برگشت: ${refundCode}` : ""}` };
    }
    return { sender: `📤 ارسال ${amt} به ${row.toName ?? "ربات مقصد"}${row.fee ? ` (کارمزد ${row.fee})` : ""}\nوضعیت: ${STATUS_FA[row.status] ?? row.status}${row.status === "pending" ? "\nمبلغ گم نمی‌شود؛ یا تحویل می‌شود یا کامل برمی‌گردد." : ""}${foot}` };
  }
  if (row.kind === "purchase_credit" && row.toUser) {
    return { receiver: `🛒 خرید شما تایید شد و ${amt} به ولتت اضافه شد.${foot}`, receiverBot: "wallet" };
  }
  return {};
}

/** Sends the tracking messages for the CURRENT status of a ledger row, once per status. Never throws. */
export async function notifyTx(ledgerId: string): Promise<void> {
  try {
    const led = await ledgerCol();
    const row0 = await led.findOne({ _id: ledgerId });
    if (!row0) return;
    // claim this status first so concurrent callers (confirm + retry sweep) do not double-send
    const row = await led.findOneAndUpdate({ _id: ledgerId, notified: { $ne: row0.status } }, { $set: { notified: row0.status } }, { returnDocument: "after" });
    if (!row) return;
    let refundCode: string | undefined;
    if (row.status === "refunded") refundCode = (await led.findOne({ _id: `refund:${row._id}` }))?.code;
    const m = messages(row, refundCode);
    const jobs: Promise<void>[] = [];
    if (m.sender && row.fromUser) jobs.push(withTimeout(sender("wallet", row.fromUser, m.sender)));
    if (m.receiver && row.toUser && m.receiverBot && row.status === "completed") jobs.push(withTimeout(sender(m.receiverBot, row.toUser, m.receiver)));
    const res = await Promise.allSettled(jobs);
    for (const r of res) if (r.status === "rejected") console.error("[wallet] tracking notify failed:", r.reason instanceof Error ? r.reason.name : "unknown");
  } catch (err) {
    console.error("[wallet] tracking notify error:", err instanceof Error ? err.name : "unknown");
  }
}
