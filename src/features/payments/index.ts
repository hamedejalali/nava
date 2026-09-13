import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { creditPurchaseOnce } from "../../db/models/relic.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";

const BUY_CALLBACK_PREFIX = "relic:buy:"; // + package index

/** Payload format: "relic:<packageIndex>". The backend always resolves
 *  packageIndex -> the actual stars/relic amounts (from env.starsPackages)
 *  — the client-visible payload is only ever an index, never a trusted
 *  price, per "never trust client-provided prices". */
function encodePayload(index: number): string {
  return `relic:${index}`;
}
function decodePayload(payload: string): number | null {
  const match = /^relic:(\d+)$/.exec(payload);
  if (!match) return null;
  const index = Number(match[1]);
  return env.starsPackages[index] ? index : null;
}

export async function showRelicScreen(ctx: NavaContext): Promise<void> {
  const balance = ctx.dbUser?.relicBalance ?? 0;

  const buttons = env.starsPackages.map((pkg, index) =>
    glassButton(`⭐ ${pkg.stars} = 💰 ${pkg.relic}`, `${BUY_CALLBACK_PREFIX}${index}`, "primary", buttonIcon("CROWN"))
  );

  await ctx.reply(`👑 موجودی رلیک شما: ${balance}\n\nبرای خرید رلیک با Telegram Stars یکی از پکیج‌های زیر رو انتخاب کن:`, {
    reply_markup: inlineKeyboard(buttons.map((b) => [b])),
  });
}

export function registerRelicScreen(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.relicCoin, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRelicScreen(ctx);
  });

  composer.callbackQuery(new RegExp(`^${BUY_CALLBACK_PREFIX}(\\d+)$`), async (ctx) => {
    const index = Number(ctx.match![1]);
    const pkg = env.starsPackages[index];
    if (!pkg) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.api.sendInvoice(
      ctx.chat!.id,
      `${pkg.relic} رلیک`,
      `خرید ${pkg.relic} رلیک برای نوا`,
      encodePayload(index),
      "XTR",
      [{ label: `${pkg.relic} رلیک`, amount: pkg.stars }],
      { provider_token: "" }
    );
  });
}

export function registerStarsCheckout(composer: Composer<NavaContext>) {
  composer.on("pre_checkout_query", async (ctx) => {
    const index = decodePayload(ctx.preCheckoutQuery.invoice_payload);
    const pkg = index !== null ? env.starsPackages[index] : undefined;

    if (!pkg || ctx.preCheckoutQuery.total_amount !== pkg.stars || ctx.preCheckoutQuery.currency !== "XTR") {
      await ctx.answerPreCheckoutQuery(false, "این پکیج دیگه معتبر نیست، لطفاً دوباره تلاش کن.");
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  composer.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const index = decodePayload(payment.invoice_payload);
    const pkg = index !== null ? env.starsPackages[index] : undefined;

    if (!pkg || payment.total_amount !== pkg.stars) {
      // Should be unreachable given the pre_checkout_query guard, but
      // never credit an amount we haven't independently verified.
      // eslint-disable-next-line no-console
      console.error("[payments] successful_payment did not match a known package - not crediting.", payment);
      return;
    }

    const credited = await creditPurchaseOnce(ctx.from!.id, payment.telegram_payment_charge_id, pkg.relic, pkg.stars);
    if (!credited) return; // duplicate delivery, already credited

    await ctx.reply(`✅ ${pkg.relic} رلیک به حساب شما اضافه شد. ممنون از خریدت 🙏`);
  });
}
