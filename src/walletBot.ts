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
import { createOrder, getOrder, reviewOrder, submitReceipt } from "./db/models/walletOrders.js";

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
  package_not_found: "این بسته دیگر وجود ندارد.", buy_disabled: "خرید فعلاً فعال نیست.", order_not_open: "این سفارش دیگر منتظر رسید نیست.", receipt_empty: "رسید خالی است؛ عکس یا متن رسید را بفرست.",
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


  // ---- 🛒 buy Relic (owner-defined packages; payment text from the admin panel; owner approves the receipt)
  const reviewTarget = async () => (await getSettings()).taskReviewChatId ?? env.OWNER_ID;
  const startBuy = async (ctx: Context) => {
    const s = await getSettings();
    const pk = s.packages ?? [];
    if (!pk.length || !s.texts.buy?.trim()) return void (await ctx.reply("🛒 خرید رلیک فعلاً فعال نیست."));
    const kb = new InlineKeyboard();
    pk.forEach((p, i) => kb.row().text(`${p.relic.toLocaleString("fa-IR")} رلیک — ${p.priceToman.toLocaleString("fa-IR")} تومان`, `wb:p:${i}`));
    await ctx.reply("🛒 یکی از بسته‌ها را انتخاب کن:", { reply_markup: kb });
  };
  bot.hears(BTN.buy, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const user = await getUser(ctx.from.id);
    if (!user) return void (await ctx.reply("ابتدا /start بزن."));
    if (user.banned) return void (await ctx.reply(ERR_FA.banned!));
    await clearState(ctx.from.id);
    await startBuy(ctx);
  });
  bot.callbackQuery(/^wb:p:(\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const user = await getUser(ctx.from.id);
      if (!user || user.banned) return void (await ctx.reply(ERR_FA.banned!));
      const o = await createOrder(ctx.from.id, Number(ctx.match[1]));
      await setState(ctx.from.id, "buy_receipt", { orderId: o._id });
      const s = await getSettings();
      await ctx.reply(`${s.texts.buy}\n\n📦 بسته: ${o.relic} رلیک\n💵 مبلغ: ${o.priceToman.toLocaleString("fa-IR")} تومان\n🧾 سفارش: ${o._id}\n\nبعد از پرداخت، «عکس رسید» یا متن رسید (مثلاً شماره پیگیری) را همین‌جا بفرست.`);
    } catch (err) {
      await ctx.reply(`⚠️ ${errText(err)}`);
    }
  });
  const forwardReceipt = async (ctx: Context, orderId: string, fileId?: string, text?: string) => {
    const o = await submitReceipt(orderId, ctx.from!.id, { text, fileId });
    await clearState(ctx.from!.id);
    const to = await reviewTarget();
    const caption = `🛒 درخواست خرید رلیک\n\nکاربر: ${displayNameOf(await getUser(ctx.from!.id))} (${ctx.from!.id})\nبسته: ${o.relic} رلیک — ${o.priceToman.toLocaleString("fa-IR")} تومان\nسفارش: ${o._id}${text ? `\nمتن رسید: ${text}` : ""}`;
    const kb = new InlineKeyboard().text("✅ تایید و شارژ", `wbuy:ok:${o._id}`).text("❌ رد", `wbuy:no:${o._id}`);
    if (to) {
      if (fileId) await ctx.api.sendPhoto(to, fileId, { caption, reply_markup: kb }).catch(() => ctx.api.sendMessage(to, caption, { reply_markup: kb }));
      else await ctx.api.sendMessage(to, caption, { reply_markup: kb });
    }
    await ctx.reply("✅ رسید ثبت شد. بعد از بررسی مالک، رلیک به ولتت اضافه می‌شود و پیام می‌گیری.");
  };
  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.from || !isPrivate(ctx)) return next();
    const st = await getState(ctx.from.id);
    if (!st || st.step !== "buy_receipt") return next();
    try {
      const photos = ctx.message.photo;
      await forwardReceipt(ctx, st.data.orderId, photos[photos.length - 1]!.file_id, ctx.message.caption?.trim());
    } catch (err) {
      await ctx.reply(`⚠️ ${errText(err)}`);
    }
  });
  bot.callbackQuery(/^wbuy:(ok|no):(.+)$/, async (ctx) => {
    if (!(await isWalletAdmin(ctx.from.id))) return void (await ctx.answerCallbackQuery({ text: "دسترسی ندارید.", show_alert: true }));
    const approve = ctx.match[1] === "ok";
    const orderId = ctx.match[2]!;
    const r = await reviewOrder(orderId, approve, ctx.from.id);
    const label = { approved: "✅ تایید و شارژ شد", rejected: "❌ رد شد", already: "قبلاً تصمیم گرفته شده", not_found: "پیدا نشد", supply_exhausted: "⚠️ موجودی کل رلیک تمام شده؛ ابتدا شارژ کن" }[r];
    await ctx.answerCallbackQuery({ text: label });
    if (r === "approved" || r === "rejected") {
      const m: any = ctx.callbackQuery.message;
      const base = m?.caption ?? m?.text ?? "";
      if (m?.caption !== undefined) await ctx.editMessageCaption({ caption: `${base}\n\n${label} — ${ctx.from.first_name}` }).catch(() => {});
      else await ctx.editMessageText(`${base}\n\n${label} — ${ctx.from.first_name}`).catch(() => {});
      const o = await getOrder(orderId);
      if (o && r === "rejected") await bot.api.sendMessage(o.userId, `❌ سفارش ${o._id} تایید نشد. اگر پرداخت کرده‌ای با پشتیبانی تماس بگیر.`).catch(() => {});
      // approval message (with the tracking code) is sent by notifyTx inside reviewOrder
    }
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
    const frac = carry / 475;
    await ctx.reply(
      `${await textOf("balance")}\n\n◆ ${acct.balance} رلیک` + (frac > 0 ? ` (+${frac.toFixed(4)} در حال ماین)` : "") +
        `\n≈ ${(acct.balance * s.tomanRate).toLocaleString("fa-IR")} تومان\n\nموجودی ربات نوا (جدا از ولت): ${user.relicBalance ?? 0}\nرلیک باقی‌مانده کل: ${supply.remaining.toLocaleString("fa-IR")} از ${supply.cap.toLocaleString("fa-IR")}`,
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
      if (st.step === "buy_receipt") {
        await forwardReceipt(ctx, st.data.orderId, undefined, text.slice(0, 800));
      } else if (st.step === "send_token") {
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
