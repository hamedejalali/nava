import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { getActiveTokenInfo, issueTransferToken, revokeTransferToken } from "../../services/wallet/transferToken.js";

/**
 * «دریافت XP از ولت» — the user-facing side of the Wallet integration.
 * The user creates a personal transfer token here and pastes it in the Wallet bot; the Wallet then asks Nava
 * (signed API call) to credit XP to the account that owns that token. The token is shown ONCE, only to its owner,
 * in a private chat; only its hash is stored. A new token revokes the old one.
 */

export const XP_CB = { open: "xp:wallet", create: "xp:new", revoke: "xp:revoke", hide: "xp:hide" } as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function eligible(ctx: NavaContext): Promise<boolean> {
  const u = ctx.dbUser;
  return !!u && u.onboardingStep === "COMPLETED" && !u.banned && !(u as any).isSeed && ctx.chat?.type === "private";
}

export async function showXpWalletScreen(ctx: NavaContext): Promise<void> {
  const info = await getActiveTokenInfo(ctx.from!.id);
  const text =
    "📥 <b>دریافت XP از ولت</b>\n\n" +
    "با این بخش می‌تونی XP رو از ربات ولت به حساب نوات منتقل کنی.\n" +
    "۱) اینجا یه <b>توکن شخصی</b> بساز\n" +
    "۲) توکن رو توی ربات ولت بفرست تا حساب نوات شناسایی بشه\n" +
    "۳) مقدار XP رو توی ولت تأیید کن؛ همون مقدار دقیقاً به حسابت اضافه میشه و پیام تأیید می‌گیری.\n\n" +
    "<blockquote>⚠️ توکن فقط حساب تو رو مشخص می‌کنه و با اون هیچ‌کس نمی‌تونه XP برداره، ولی به کسی نشونش نده. اگه جایی لو رفت، توکن جدید بساز؛ توکن قبلی همون لحظه باطل میشه.</blockquote>\n\n" +
    (info ? `🔑 توکن فعال: <code>nxp_…${esc(info.hint)}</code>\n(به دلایل امنیتی توکن کامل دوباره نشون داده نمیشه؛ اگه گمش کردی توکن جدید بساز.)` : "هنوز توکنی نساختی.");
  const kb = inlineKeyboard([
    [glassButton(info ? "🔄 ساخت توکن جدید" : "🔑 ساخت توکن", XP_CB.create, "success")],
    ...(info ? [[glassButton("🚫 ابطال توکن", XP_CB.revoke, "danger")]] : []),
  ]);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export function registerXpTransfer(composer: Composer<NavaContext>) {
  composer.callbackQuery(XP_CB.open, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await eligible(ctx))) return;
    await showXpWalletScreen(ctx);
  });

  composer.callbackQuery(XP_CB.create, async (ctx) => {
    if (!(await eligible(ctx))) return void (await ctx.answerCallbackQuery());
    const rl = await checkRateLimit(ctx.from!.id, "xp-token", 5, 10 * 60_000);
    if (!rl.allowed) return void (await ctx.answerCallbackQuery({ text: "چند دقیقه صبر کن و دوباره امتحان کن.", show_alert: true }));
    await ctx.answerCallbackQuery();
    const t = await issueTransferToken(ctx.from!.id);
    await ctx.reply(
      "🔑 <b>توکن انتقال XP تو</b>\n\n" +
        `<code>${esc(t.token)}</code>\n\n` +
        "روی توکن بزن تا کپی بشه و توی ربات ولت بفرستش.\n" +
        "<blockquote>این توکن فقط همین یه بار کامل نشون داده میشه. بعد از استفاده پیام رو پاک کن. توکن قبلی باطل شد.</blockquote>",
      { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("🗑 پاک کردن این پیام", XP_CB.hide, "danger")]]) }
    );
  });

  composer.callbackQuery(XP_CB.revoke, async (ctx) => {
    if (!(await eligible(ctx))) return void (await ctx.answerCallbackQuery());
    const done = await revokeTransferToken(ctx.from!.id, "user");
    await ctx.answerCallbackQuery({ text: done ? "توکن باطل شد ✅" : "توکن فعالی نداشتی.", show_alert: true });
  });

  composer.callbackQuery(XP_CB.hide, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });
}
