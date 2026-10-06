import { Bot, InlineKeyboard, type Context } from "grammy";
import { env } from "./config/env.js";
import { getOrCreateUser, getUser } from "./db/models/user.js";
import { telegramRetryTransformer } from "./ui/telegramRetry.js";
import { WalletError, displayNameOf, getOrCreateAccount, getSettings, getSupply } from "./db/models/walletCore.js";
import { listPartners } from "./db/models/walletPartners.js";
import { cancelQuote, confirmQuote, createQuote, resolveDestination } from "./db/models/walletTransfers.js";
import { clearState, getState, setState } from "./db/models/walletBotState.js";
import { getMiningCarry } from "./db/models/walletMining.js";
import { flushTxLog } from "./services/walletTxLog.js";
import { isWalletAdmin, registerWalletAdmin, ADMIN_BUTTON } from "./features/walletAdmin.js";
import { reviewClaim } from "./db/models/walletTasks.js";

/**
 * Premium Wallet bot (v1.11.0). Colored reply-keyboard buttons, each doing its own job:
 *   💰 موجودی  -> real wallet balance        📥 دریافت -> your wallet token + explanation
 *   📤 ارسال   -> guided send flow (token -> owner name confirm -> amount -> confirm)
 * plus the full Mini App via an inline web_app button, and an owner/admin settings panel.
 * Every text shown to users that the owner may want to change is stored in the database
 * (wallet_settings.texts), never in env.
 */
export const BTN = { balance: "💰 موجودی", send: "📤 ارسال", receive: "📥 دریافت", buy: "🛒 خرید رلیک" } as const;

export const DEFAULT_TEXTS = {
  welcome: "به ولت پریمیوم نوا خوش اومدی! 👑\nاز دکمه‌های پایین برای موجودی، ارسال و دریافت رلیک استفاده کن، یا کیف پول کامل (ماین، تسک‌ها، تاریخچه) رو باز کن:",
  receive: "📥 دریافت رلیک\n\nاین «توکن ولت» توئه. به کسی که می‌خواد برات رلیک بفرسته بده؛ اون توی بخش «ارسال» همین توکن رو وارد می‌کنه و نام تو رو برای تایید می‌بینه.\n\n⚠️ این توکن فقط برای دریافته؛ با داشتنش کسی نمی‌تونه از ولتت برداشت کنه. با توکن ربات نوا (آیدی عمومی) فرق داره.",
  sendIntro: "📤 ارسال رلیک\n\nمقصد رو انتخاب کن:",
  balance: "💰 موجودی ولت",
} as const;

export async function textOf(key: keyof typeof DEFAULT_TEXTS): Promise<string> {
  const s = await getSettings();
  return s.texts[key] || DEFAULT_TEXTS[key];
}

const esc = (t: string) => t.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export const ERR_FA: Record<string, string> = {
  invalid_token: "توکن معتبر نیست.", target_not_found: "صاحب این توکن پیدا نشد.", self_transfer: "نمی‌تونی به خودت ارسال کنی.",
  insufficient_balance: "موجودی کافی نیست.", below_min: "مقدار کمتر از حداقل مجاز است.", above_max: "مقدار بیشتر از حداکثر مجاز است.",
  invalid_amount: "مقدار نامعتبر است (عدد صحیح مثبت بفرست).", intent_expired: "زمان تایید تموم شد؛ دوباره شروع کن.", intent_not_found: "این درخواست دیگه معتبر نیست.",
  rate_limited: "تعداد تلاش‌ها زیاد بود؛ کمی بعد دوباره امتحان کن.", banned: "حساب شما محدود شده است.", partner_unavailable: "ربات مقصد فعلاً در دسترس نیست؛ بعداً امتحان کن.",
  partner_refused: "ربات مقصد پذیرفت نکرد؛ مبلغ کامل به ولتت برگشت.", not_found: "ابتدا /start بزن.", server_error: "خطای موقت؛ دوباره تلاش کن.",
  pending_elsewhere: "درخواست در حال انجام است؛ چند ثانیه بعد موجودی رو ببین.",
};
export const errText = (err: unknown) => (err instanceof WalletError ? ERR_FA[err.code] ?? "عملیات انجام نشد." : ERR_FA.server_error!);

export async function mainKeyboard(userId: number) {
  const rows: any[][] = [
    [{ text: BTN.balance, style: "primary" }, { text: BTN.send, style: "success" }, { text: BTN.receive, style: "primary" }],
    [{ text: BTN.buy, style: "success" }],
  ];
  if (await isWalletAdmin(userId)) rows.push([{ text: ADMIN_BUTTON, style: "danger" }]);
  return { keyboard: rows as any, resize_keyboard: true, is_persistent: true };
}

export function createWalletBot() {
  const token = env.WALLET_BOT_TOKEN;
  if (!token) throw new Error("[walletBot] WALLET_BOT_TOKEN is not set.");

  const bot = new Bot<Context>(token);
  bot.api.config.use(telegramRetryTransformer);

  // never process groups/channels except callbacks from the review channel
  const isPrivate = (ctx: Context) => ctx.chat?.type === "private";

  bot.command("start", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    await clearState(ctx.from.id);
    // Same shared `users` collection as the Nava bot (identity); the BALANCE is the wallet's own.
    await getOrCreateUser({ telegramId: ctx.from.id, firstName: ctx.from.first_name, username: ctx.from.username });
    await getOrCreateAccount(ctx.from.id);
    await ctx.reply(await textOf("welcome"), { reply_markup: await mainKeyboard(ctx.from.id) });
    const url = env.WALLET_MINIAPP_URL;
    if (url) await ctx.reply("👇", { reply_markup: new InlineKeyboard().webApp("👑 باز کردن کیف پول", url) });
    else await ctx.reply("Mini App هنوز پیکربندی نشده (WALLET_MINIAPP_URL).");
  });

  // ---- task review decisions (pressed in the owner's review channel)
  bot.callbackQuery(/^wtask:(ok|no):(.+)$/, async (ctx) => {
    if (!(await isWalletAdmin(ctx.from.id))) return void (await ctx.answerCallbackQuery({ text: "دسترسی ندارید.", show_alert: true }));
    const approve = ctx.match[1] === "ok";
    const r = await reviewClaim(ctx.match[2]!, approve, ctx.from.id);
    const label = { approved: "✅ تایید شد", rejected: "❌ رد شد", already: "قبلاً تصمیم گرفته شده", not_found: "پیدا نشد", supply_exhausted: "⚠️ موجودی کل رلیک تمام شده" }[r];
    await ctx.answerCallbackQuery({ text: label });
    if (r === "approved" || r === "rejected") await ctx.editMessageText(`${ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ""}\n\n${label} — توسط ${ctx.from.first_name}`).catch(() => {});
    if (r === "approved" || r === "rejected") {
      const claimUser = Number(ctx.match[2]!.split(":")[1]);
      if (Number.isFinite(claimUser)) await bot.api.sendMessage(claimUser, approve ? "✅ تسک شما تایید شد و جایزه به ولت اضافه شد." : "❌ تسک شما تایید نشد. می‌تونی دوباره انجام و ثبت کنی.").catch(() => {});
    }
  });


  // ---- 🛒 buy Relic: glass (inline) buttons fully defined by the owner in the admin panel (title + payment link + Relic amount).
  // Payment itself happens on the owner's link; when the payment API confirms (partner `credit` with packageId) the Relic is
  // credited to the wallet and the user is notified with a tracking code.
  bot.hears(BTN.buy, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const user = await getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("ابتدا /start بزن."));
    if (user.banned) return void (await ctx.reply(ERR_FA.banned!));
    await clearState(ctx.from.id);
    const s = await getSettings();
    const pk = s.packages ?? [];
    if (!pk.length) return void (await ctx.reply("🛒 خرید رلیک فعلاً فعال نیست."));
    const acct = await getOrCreateAccount(ctx.from.id);
    const kb = new InlineKeyboard();
    for (const p of pk) {
      const url = p.url.replaceAll("{uid}", String(ctx.from.id)).replaceAll("{token}", encodeURIComponent(acct.token));
      kb.row().url(p.title, url);
    }
    await ctx.reply(s.texts.buy?.trim() || "🛒 یکی از بسته‌ها را انتخاب کن. بعد از پرداخت موفق، رلیک خودکار به ولتت اضافه می‌شود و پیام تایید می‌گیری.", { reply_markup: kb });
  });

  registerWalletAdmin(bot);

  // ---- 💰 balance
  bot.hears(BTN.balance, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    await clearState(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("ابتدا /start بزن."));
    if (user.banned) return void (await ctx.reply(ERR_FA.banned!));
    const [acct, s, carry, supply] = await Promise.all([getOrCreateAccount(ctx.from.id), getSettings(), getMiningCarry(ctx.from.id), getSupply()]);
    // Same number as the Mini App shows: whole Relic + the share already mined toward the next one.
    const total = acct.balance + carry / 475;
    await ctx.reply(
      `${await textOf("balance")}\n\n◆ ${total.toFixed(4)} رلیک` +
        `\nقابل ارسال (کامل): ${acct.balance} رلیک\n≈ ${Math.floor(total * s.tomanRate).toLocaleString("fa-IR")} تومان\n\nموجودی ربات نوا (جدا از ولت): ${user.relicBalance ?? 0}\nرلیک باقی‌مانده کل: ${supply.remaining.toLocaleString("fa-IR")} از ${supply.cap.toLocaleString("fa-IR")}`,
    );
  });

  // ---- 📥 receive
  bot.hears(BTN.receive, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    await clearState(ctx.from.id);
    const user = await getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("ابتدا /start بزن."));
    if (user.banned) return void (await ctx.reply(ERR_FA.banned!));
    const acct = await getOrCreateAccount(ctx.from.id);
    await ctx.reply(`${await textOf("receive")}\n\nتوکن ولت تو:\n<code>${esc(acct.token)}</code>`, { parse_mode: "HTML" });
  });

  // ---- 📤 send
  bot.hears(BTN.send, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const user = await getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("ابتدا /start بزن."));
    if (user.banned) return void (await ctx.reply(ERR_FA.banned!));
    await clearState(ctx.from.id);
    const partners = await listPartners(true);
    const kb = new InlineKeyboard().text("👛 ولت دیگر", "ws:d:wallet").text("💬 ربات نوا", "ws:d:nava");
    partners.forEach((p, i) => { if (i % 2 === 0) kb.row(); kb.text(`🤖 ${p.name}`, `ws:p:${p._id}`); });
    await ctx.reply(await textOf("sendIntro"), { reply_markup: kb });
  });

  bot.callbackQuery(/^ws:(d|p):(.+)$/, async (ctx) => {
    const kind = ctx.match[1] === "d" ? ctx.match[2]! : "partner";
    const partnerId = ctx.match[1] === "p" ? ctx.match[2]! : undefined;
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "send_token", { dest: kind, partnerId });
    const hint = kind === "wallet" ? "توکن ولت گیرنده (RLC-XXXX-XXXX-XXXX-XXXX)" : kind === "nava" ? "توکن گیرنده در ربات نوا (آیدی عمومی، مثل user_AbC123)" : "توکن کاربر در ربات مقصد";
    await ctx.reply(`${hint} را بفرست:`);
  });

  bot.callbackQuery("ws:mismatch", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await clearState(ctx.from.id);
    await ctx.editMessageText("❌ مغایرت اعلام شد؛ ارسال لغو شد. توکن را بررسی کن و دوباره از «ارسال» شروع کن.").catch(() => {});
  });

  bot.callbackQuery("ws:owner_ok", async (ctx) => {
    await ctx.answerCallbackQuery();
    const st = await getState(ctx.from.id);
    if (!st || st.step !== "send_owner") return void (await ctx.reply("این مرحله منقضی شده؛ دوباره از «ارسال» شروع کن."));
    await setState(ctx.from.id, "send_amount", st.data);
    await ctx.editMessageReplyMarkup().catch(() => {});
    const s = await getSettings();
    await ctx.reply(`مقدار رلیک را بفرست (عدد صحیح، حداقل ${s.transferMin}):`);
  });

  bot.callbackQuery(/^ws:go:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    try {
      const r = await confirmQuote(ctx.from.id, ctx.match[1]);
      await clearState(ctx.from.id);
      await flushTxLog(10);
      await ctx.reply(
        r.status === "completed"
          ? `✅ انجام شد.\nموجودی جدید: ${r.newBalance} رلیک\n🔎 کد پیگیری:\n<code>${esc(r.code ?? r.txId)}</code>`
          : `⏳ تراکنش ثبت شد و در حال تحویل به ربات مقصد است. مبلغ از ولتت کم شده و گم نمی‌شود؛ یا تحویل می‌شود یا کامل برمی‌گردد.\n🔎 کد پیگیری:\n<code>${esc(r.code ?? r.txId)}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      if (err instanceof WalletError && err.code === "partner_refused") await clearState(ctx.from.id);
      await ctx.reply(`⚠️ ${errText(err)}`);
    }
  });

  bot.callbackQuery(/^ws:cancel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    await clearState(ctx.from.id);
    await cancelQuote(ctx.from.id, ctx.match[1]).catch(() => {});
    await ctx.editMessageText("❌ ارسال لغو شد.").catch(() => {});
  });

  // ---- free-text steps of the send flow (admin flows are handled in walletAdmin before this)
  bot.on("message:text", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const st = await getState(ctx.from.id);
    if (!st) return;
    const text = ctx.message.text.trim();
    try {
      if (st.step === "send_token") {
        const dest = await resolveDestination(ctx.from.id, { dest: st.data.dest, partnerId: st.data.partnerId, token: text });
        await setState(ctx.from.id, "send_owner", { ...st.data, token: text });
        await ctx.reply(
          `صاحب این توکن:\n\n👤 ${esc(dest.displayName)}\n🔑 ${esc(dest.tokenMasked)}\n\nمطمئنی؟`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ تایید", "ws:owner_ok").text("❌ مغایرت", "ws:mismatch") },
        );
      } else if (st.step === "send_amount") {
        const amount = Number(text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
        const q = await createQuote(ctx.from.id, { dest: st.data.dest, partnerId: st.data.partnerId, token: st.data.token, amount });
        await ctx.reply(
          `📋 خلاصه\n\nگیرنده: ${esc(q.dest.displayName)}\nمقدار: ${q.amount} رلیک\nکارمزد: ${q.fee}\nمجموع کسر از ولت: ${q.total}\n\n⏱ تا ۲ دقیقه معتبر است.`,
          { reply_markup: new InlineKeyboard().text("✅ تایید و ارسال", `ws:go:${q.intentId}`).text("❌ لغو", `ws:cancel:${q.intentId}`) },
        );
      }
    } catch (err) {
      if (err instanceof WalletError && ["rate_limited", "banned", "insufficient_balance", "target_not_found", "self_transfer"].includes(err.code) && st.step === "send_token") await clearState(ctx.from.id);
      await ctx.reply(`⚠️ ${errText(err)}`);
    }
  });

  bot.catch((err) => {
    console.error("[walletBot] Unhandled error:", err.error instanceof Error ? err.error.name : "unknown");
  });

  return bot;
}
