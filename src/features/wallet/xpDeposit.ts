import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";
import { parseXpAmount } from "../../services/wallet/xpAmount.js";
import {
  activeDepositOf, createDeposit, creditedMessage, depositAvailable, describeWalletError, normalizeWalletToken, notifyOutcome, pollDeposit, syncDeposit,
  type DepositDoc, type SyncOutcome,
} from "../../services/wallet/walletDeposits.js";

/**
 * «واریز XP از ولت» — Nava asks the Wallet for a transfer on the user's behalf.
 * Flow: amount → wallet token (PW-XXXX-…) → request created (status PENDING) → the user approves in the Wallet bot
 * → Nava reads the transfer back and credits `amount` once, only when the Wallet says COMPLETED.
 */
export const XP_CB = { open: "xp:wallet", create: "xp:new", check: "xp:chk" } as const;
const FLOW = "wallet_deposit_flow";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
type Flow = { _id: number; step: "amount" | "token"; amount?: number; at: Date };

async function flowCol() {
  return (await getDb()).collection<Flow>(FLOW);
}
async function eligible(ctx: NavaContext): Promise<boolean> {
  const u = ctx.dbUser;
  return !!u && u.onboardingStep === "COMPLETED" && !u.banned && !(u as any).isSeed && ctx.chat?.type === "private";
}
const checkKb = (d: DepositDoc) => inlineKeyboard([[glassButton("🔄 بررسی وضعیت", `${XP_CB.check}:${d._id}`, "primary")]]);

function statusText(d: DepositDoc): string {
  const fee = d.fee !== undefined ? `\nکارمزد (فقط سمت ولت): ${d.fee} XP\nمجموع کسر از ولت: ${d.total} XP` : "";
  return (
    `📥 <b>درخواست واریز ${d.amount} XP</b>${fee}\n\n` +
    "حالا ربات ولت رو باز کن و دکمه‌ی «✅ تایید انتقال» رو بزن. مبلغ، کارمزد و مقصد اونجا بهت نشون داده میشه.\n" +
    "تا تایید نکنی هیچ XP‌ای جابه‌جا نمیشه و درخواست بعد از ۱۰ دقیقه خودکار منقضی میشه.\n" +
    "<blockquote>بعد از تایید، دکمه‌ی «بررسی وضعیت» رو بزن؛ XP همون لحظه‌ای که ولت تایید نهایی بده اضافه میشه.</blockquote>"
  );
}

async function renderOutcome(ctx: NavaContext, o: SyncOutcome) {
  const d = o.deposit;
  if (o.credited) return void (await ctx.reply(creditedMessage(o), { parse_mode: "HTML" }));
  if (d.status === "completed") return void (await ctx.reply("✅ این واریز قبلاً انجام شده و XP به حسابت اضافه شده."));
  if (d.status === "failed") return void (await ctx.reply(`❌ ${describeWalletError(d.failureCode ?? "")}\nهیچ XP‌ای کم یا زیاد نشد.`));
  await ctx.reply(
    d.status === "creating"
      ? "⏳ هنوز ارتباط با ولت کامل نشده؛ چند لحظه بعد «بررسی وضعیت» رو بزن."
      : d.walletStatus === "PROCESSING" || d.walletStatus === "REQUIRES_RECONCILIATION"
        ? "⏳ ولت داره انتقال رو نهایی می‌کنه؛ این خطا نیست. کمی بعد دوباره بررسی کن."
        : "⏳ هنوز توی ولت تایید نشده. ربات ولت رو باز کن و «✅ تایید انتقال» رو بزن، بعد اینجا دوباره بررسی کن.",
    { reply_markup: checkKb(d) },
  );
}

export async function showXpWalletScreen(ctx: NavaContext): Promise<void> {
  if (!(await depositAvailable())) return void (await ctx.reply("واریز XP از ولت فعلاً در دسترس نیست."));
  const pending = await activeDepositOf(ctx.from!.id);
  if (pending) {
    const o = await syncDeposit(pending._id);
    if (o && (o.credited || o.deposit.status !== "pending")) {
      await notifyOutcome(ctx.api, o).catch(() => {});
    } else if (o) {
      return void (await ctx.reply(statusText(o.deposit), { parse_mode: "HTML", reply_markup: checkKb(o.deposit) }));
    }
  }
  await ctx.reply(
    "📥 <b>واریز XP از ولت</b>\n\n" +
      "۱) مقدار XP رو بنویس\n" +
      "۲) توکن ولتت رو بفرست (از ربات ولت، قالب <code>PW-XXXX-XXXX-XXXX-XXXX</code>)\n" +
      "۳) توی ربات ولت «✅ تایید انتقال» رو بزن\n\n" +
      "کارمزد فقط از ولت کم میشه؛ همون مقدار دقیقاً به XP نوات اضافه میشه.",
    { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("➕ شروع واریز", XP_CB.create, "success")]]) },
  );
}

export function registerXpDeposit(composer: Composer<NavaContext>) {
  composer.callbackQuery(XP_CB.open, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await eligible(ctx))) return;
    await showXpWalletScreen(ctx);
  });

  composer.callbackQuery(XP_CB.create, async (ctx) => {
    if (!(await eligible(ctx))) return void (await ctx.answerCallbackQuery());
    if (!(await depositAvailable())) return void (await ctx.answerCallbackQuery({ text: "فعلاً در دسترس نیست.", show_alert: true }));
    const rl = await checkRateLimit(ctx.from!.id, "wallet-deposit", 6, 10 * 60_000);
    if (!rl.allowed) return void (await ctx.answerCallbackQuery({ text: "چند دقیقه صبر کن و دوباره امتحان کن.", show_alert: true }));
    await ctx.answerCallbackQuery();
    await clearAllUserFlows(ctx.from!.id);
    await (await flowCol()).updateOne({ _id: ctx.from!.id }, { $set: { step: "amount", at: new Date() }, $unset: { amount: "" } }, { upsert: true });
    await ctx.reply("چند XP می‌خوای از ولت واریز کنی؟ (فقط عدد صحیح)", { reply_markup: cancelKeyboard() });
  });

  composer.on("message:text", async (ctx, next) => {
    const flows = await flowCol();
    const f = await flows.findOne({ _id: ctx.from.id });
    if (!f) return next();
    if (Date.now() - f.at.getTime() > 15 * 60_000) {
      await flows.deleteOne({ _id: ctx.from.id });
      return next();
    }
    if (f.step === "amount") {
      const p = parseXpAmount(ctx.message.text, { humanDigits: true });
      if (!p.ok) return void (await ctx.reply("مقدار باید یه عدد صحیح و مثبت باشه (بدون اعشار و کاما).", { reply_markup: cancelKeyboard() }));
      await flows.updateOne({ _id: ctx.from.id }, { $set: { step: "token", amount: p.amount, at: new Date() } });
      return void (await ctx.reply(`باشه، ${p.amount} XP.\nحالا توکن ولتت رو بفرست (قالب PW-XXXX-XXXX-XXXX-XXXX).`, { reply_markup: cancelKeyboard() }));
    }
    // step "token"
    const token = normalizeWalletToken(ctx.message.text);
    if (!token) return void (await ctx.reply("قالب توکن درست نیست. باید شبیه PW-AB12-CD34-EF56-GH78 باشه.", { reply_markup: cancelKeyboard() }));
    await flows.deleteOne({ _id: ctx.from.id });
    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}); // don't leave the token in the chat
    const r = await createDeposit({ userId: ctx.from.id, chatId: ctx.chat.id, rawToken: token, amount: f.amount! });
    if (!r.ok) {
      if (r.reason === "active_exists" && r.deposit) return void (await ctx.reply("یه واریز در حال انتظار داری:\n\n" + statusText(r.deposit), { parse_mode: "HTML", reply_markup: checkKb(r.deposit) }));
      if (r.reason === "wallet_error" && r.deposit) return void (await ctx.reply("⏳ ارتباط با ولت ناقص موند. نگران نباش، دوباره امتحان نکن؛ چند لحظه بعد «بررسی وضعیت» رو بزن.", { reply_markup: checkKb(r.deposit) }));
      return void (await ctx.reply(r.reason === "unavailable" ? "واریز از ولت فعلاً در دسترس نیست." : describeWalletError(r.code ?? "")));
    }
    await ctx.reply(statusText(r.deposit), { parse_mode: "HTML", reply_markup: checkKb(r.deposit) });
    // the user usually approves within seconds: look for a short while, then hand over to the button / the sweeper
    const o = await pollDeposit(r.deposit._id, 15_000).catch(() => null);
    if (o && (o.credited || o.deposit.status !== "pending")) {
      await notifyOutcome(ctx.api, o).catch(() => {});
    }
  });

  composer.callbackQuery(new RegExp(`^${XP_CB.check}:([0-9a-f-]{36})$`), async (ctx) => {
    const id = String(ctx.match![1]);
    const row = await (await getDb()).collection<any>("wallet_deposits").findOne({ _id: id });
    if (!row || row.userId !== ctx.from!.id) return void (await ctx.answerCallbackQuery());
    const rl = await checkRateLimit(ctx.from!.id, "wallet-check", 20, 60_000);
    if (!rl.allowed) return void (await ctx.answerCallbackQuery({ text: "کمی صبر کن.", show_alert: false }));
    await ctx.answerCallbackQuery();
    const o = await syncDeposit(id);
    if (!o) return;
    await renderOutcome(ctx, o);
    // the user has seen the result: the sweeper must not send it a second time
    if (o.credited || o.deposit.status === "failed" || o.deposit.status === "completed") {
      await (await getDb()).collection<any>("wallet_deposits").updateOne({ _id: id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: new Date() } });
    }
  });
}
