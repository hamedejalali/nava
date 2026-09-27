import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon, textEmoji } from "../../config/emojis.js";
import { creditPurchaseOnce } from "../../db/models/relic.js";
import { getPackages } from "../../db/models/pricing.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { env } from "../../config/env.js";

const OPEN_CB = { stars: "relic:open:stars", gateway: "relic:open:gateway" };
const BUY_STARS_PREFIX = "relic:buy:stars:"; // + package index
const BUY_GATEWAY_PREFIX = "relic:buy:gateway:"; // + package index

/** Payload format: "relic:<packageIndex>". The backend always resolves
 *  packageIndex -> the actual Stars/Relic amounts from the CURRENT
 *  admin-configured pricing (see src/db/models/pricing.ts) at the moment
 *  of purchase — the client-visible payload is only ever an index, never
 *  a trusted price, per "never trust client-provided prices". A pricing
 *  change between "show the button" and "tap the button" is fine: the
 *  price actually charged always matches whatever's live right now. */
function encodePayload(index: number): string {
  return `relic:${index}`;
}
function decodeIndex(payload: string): number | null {
  const match = /^relic:(\d+)$/.exec(payload);
  return match ? Number(match[1]) : null;
}

export async function showRelicScreen(ctx: NavaContext): Promise<void> {
  const balance = ctx.dbUser?.relicBalance ?? 0;
  const relicEmoji = textEmoji("RELIC", "👑");

  await ctx.reply(`${relicEmoji} موجودی رلیک شما: ${balance}\n\nاز کدوم روش می‌خوای رلیک بخری؟`, {
    reply_markup: inlineKeyboard([
      [glassButton("⭐ خرید رلیک با Telegram Stars", OPEN_CB.stars, "primary", buttonIcon("CROWN"))],
      [glassButton("💳 خرید رلیک از طریق درگاه", OPEN_CB.gateway, "primary", buttonIcon("CROWN"))],
    ]),
  });
}

export function registerRelicScreen(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.relicCoin, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRelicScreen(ctx);
  });

  composer.callbackQuery(OPEN_CB.stars, async (ctx) => {
    await ctx.answerCallbackQuery();
    const packages = await getPackages("stars");
    if (packages.length === 0) {
      await ctx.reply("فعلاً پکیجی برای خرید با استارز تنظیم نشده.");
      return;
    }
    const buttons = packages.map((pkg, index) =>
      glassButton(`⭐ ${pkg.price} = 👑 ${pkg.relic}`, `${BUY_STARS_PREFIX}${index}`, "primary", buttonIcon("CROWN"))
    );
    await ctx.reply("یکی از پکیج‌های زیر رو انتخاب کن:", { reply_markup: inlineKeyboard(buttons.map((b) => [b])) });
  });

  composer.callbackQuery(OPEN_CB.gateway, async (ctx) => {
    await ctx.answerCallbackQuery();
    // (getPackages falls back to 5 ready-made default packages until real
    //  ones are set from the admin panel.)
    const packages = await getPackages("gateway");
    const buttons = packages.map((pkg, index) =>
      glassButton(`${pkg.price.toLocaleString("fa-IR")} تومان = ${pkg.relic} رلیک`, `${BUY_GATEWAY_PREFIX}${index}`, index % 2 === 0 ? "primary" : "success", buttonIcon("CROWN"))
    );
    await ctx.reply("💳 خرید رلیک از طریق درگاه\n\nیکی از پکیج‌های زیر رو انتخاب کن:", {
      reply_markup: inlineKeyboard(buttons.map((b) => [b])),
    });
  });

  composer.callbackQuery(new RegExp(`^${BUY_STARS_PREFIX}(\\d+)$`), async (ctx) => {
    const index = Number(ctx.match![1]);
    const packages = await getPackages("stars");
    const pkg = packages[index];
    if (!pkg) {
      await ctx.answerCallbackQuery({ text: "این پکیج دیگه معتبر نیست." });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.api.sendInvoice(
      ctx.chat!.id,
      `${pkg.relic} رلیک`,
      `خرید ${pkg.relic} رلیک برای نوا`,
      encodePayload(index),
      "XTR",
      [{ label: `${pkg.relic} رلیک`, amount: pkg.price }],
      { provider_token: "" }
    );
  });

  // Gateway checkout isn't connected in Nava bot yet (no merchant
  // credentials configured) — per current plan, the actual payment step
  // happens inside the Premium Wallet mini-app instead. This just hands
  // the user off there with the package they picked already in mind.
  composer.callbackQuery(new RegExp(`^${BUY_GATEWAY_PREFIX}(\\d+)$`), async (ctx) => {
    const index = Number(ctx.match![1]);
    const packages = await getPackages("gateway");
    const pkg = packages[index];
    if (!pkg) {
      await ctx.answerCallbackQuery({ text: "این پکیج دیگه معتبر نیست." });
      return;
    }
    // Not connected yet -> friendly notice. Once the wallet bot is ready,
    // set WALLET_BOT_USERNAME in env and this hands the buyer over to it.
    const wallet = env.WALLET_BOT_USERNAME?.replace(/^@/, "");
    if (!wallet) {
      await ctx.answerCallbackQuery({ text: "درگاه پرداخت هنوز فعال نشده؛ به‌زودی فعال میشه 🙏", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `برای تکمیل خرید ${pkg.relic} رلیک با ${pkg.price.toLocaleString("fa-IR")} تومان، به ربات ولت نوا برو و پرداختت رو اونجا کامل کن:\nhttps://t.me/${wallet}`
    );
  });
}

export function registerStarsCheckout(composer: Composer<NavaContext>) {
  composer.on("pre_checkout_query", async (ctx) => {
    const index = decodeIndex(ctx.preCheckoutQuery.invoice_payload);
    const packages = await getPackages("stars");
    const pkg = index !== null ? packages[index] : undefined;

    if (!pkg || ctx.preCheckoutQuery.total_amount !== pkg.price || ctx.preCheckoutQuery.currency !== "XTR") {
      await ctx.answerPreCheckoutQuery(false, "این پکیج دیگه معتبر نیست، لطفاً دوباره تلاش کن.");
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  composer.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const index = decodeIndex(payment.invoice_payload);
    const packages = await getPackages("stars");
    const pkg = index !== null ? packages[index] : undefined;

    if (!pkg || payment.total_amount !== pkg.price) {
      // Should be unreachable given the pre_checkout_query guard, but
      // never credit an amount we haven't independently verified.
      console.error("[payments] successful_payment did not match a known package - not crediting.", payment);
      return;
    }

    const credited = await creditPurchaseOnce(ctx.from!.id, payment.telegram_payment_charge_id, pkg.relic, pkg.price);
    if (!credited) return; // duplicate delivery, already credited

    const relicEmoji = textEmoji("RELIC", "👑");
    await ctx.reply(`✅ ${pkg.relic} ${relicEmoji} رلیک به حساب شما اضافه شد. ممنون از خریدت 🙏`);
  });
}
