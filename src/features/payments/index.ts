import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon, textEmoji } from "../../config/emojis.js";
import { creditPurchaseOnce } from "../../db/models/relic.js";
import { getPackages } from "../../db/models/pricing.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { XP_CB } from "../wallet/xpDeposit.js";
import { env } from "../../config/env.js";
import { getOrCreateStarsOrder, getStarsOrder, markStarsOrderFulfilled, recordStarsPaymentException, type StarsOrderDoc } from "../../db/models/starsOrder.js";

const OPEN_CB = { stars: "relic:open:stars", gateway: "relic:open:gateway" };
const BUY_STARS_PREFIX = "relic:buy:stars:"; // + package index
const BUY_GATEWAY_PREFIX = "relic:buy:gateway:"; // + package index

/** Payload formats:
 *   "relic:o:<orderId>"  (current) — points at the persisted order (package + price as OFFERED at invoice time);
 *   "relic:<packageIndex>" (legacy, invoices created by older versions) — resolved from the live package list.
 *  The payload is never a trusted price: amounts are always checked against the order / package record. */
function encodePayload(orderId: string): string {
  return `relic:o:${orderId}`;
}
function decodeOrderId(payload: string): string | null {
  const match = /^relic:o:([A-Za-z0-9_-]{6,40})$/.exec(payload);
  return match ? match[1]! : null;
}
function decodeIndex(payload: string): number | null {
  const match = /^relic:(\d+)$/.exec(payload);
  return match ? Number(match[1]) : null;
}

type Resolved = { ok: true; relic: number; price: number; orderId?: string } | { ok: false; reason: string; orderId?: string };

/** Resolves what a Stars payload is supposed to be worth: from the original order when there is one. */
async function resolveStarsPayload(payload: string): Promise<Resolved> {
  const orderId = decodeOrderId(payload);
  if (orderId) {
    const order: StarsOrderDoc | null = await getStarsOrder(orderId);
    if (!order) return { ok: false, reason: "unknown_order", orderId };
    return { ok: true, relic: order.relic, price: order.price, orderId };
  }
  const index = decodeIndex(payload);
  if (index === null) return { ok: false, reason: "bad_payload" };
  const pkg = (await getPackages("stars"))[index];
  if (!pkg) return { ok: false, reason: "legacy_package_missing" };
  return { ok: true, relic: pkg.relic, price: pkg.price };
}

export async function showRelicScreen(ctx: NavaContext): Promise<void> {
  const balance = ctx.dbUser?.relicBalance ?? 0;
  const relicEmoji = textEmoji("RELIC", "👑");

  await ctx.reply(`${relicEmoji} موجودی XP شما: ${balance}\n\nاز کدوم روش می‌خوای XP بخری؟`, {
    reply_markup: inlineKeyboard([
      [glassButton("⭐ خرید XP با Telegram Stars", OPEN_CB.stars, "primary", buttonIcon("CROWN"))],
      [glassButton("💳 خرید XP از طریق درگاه", OPEN_CB.gateway, "primary", buttonIcon("CROWN"))],
      [glassButton("📥 واریز XP از ولت", XP_CB.open, "success")],
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
      glassButton(`${pkg.price.toLocaleString("fa-IR")} تومان = ${pkg.relic} XP`, `${BUY_GATEWAY_PREFIX}${index}`, index % 2 === 0 ? "primary" : "success", buttonIcon("CROWN"))
    );
    await ctx.reply("💳 خرید XP از طریق درگاه\n\nیکی از پکیج‌های زیر رو انتخاب کن:", {
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
    const order = await getOrCreateStarsOrder(ctx.from!.id, index, pkg);
    await ctx.api.sendInvoice(
      ctx.chat!.id,
      `${order.relic} XP`,
      `خرید ${order.relic} XP برای نوا`,
      encodePayload(order._id),
      "XTR",
      [{ label: `${order.relic} XP`, amount: order.price }],
      { provider_token: "" }
    );
  });

  // Gateway checkout isn't connected yet — friendly notice only.
  composer.callbackQuery(new RegExp(`^${BUY_GATEWAY_PREFIX}(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery({ text: "درگاه پرداخت هنوز فعال نشده؛ به‌زودی فعال میشه 🙏", show_alert: true });
  });
}

export function registerStarsCheckout(composer: Composer<NavaContext>) {
  composer.on("pre_checkout_query", async (ctx) => {
    const q = ctx.preCheckoutQuery;
    const r = await resolveStarsPayload(q.invoice_payload);
    // The invoice must still be a real one we created and the amount/currency must match what was OFFERED
    // (an order stays payable even if the live price list changed afterwards — the user sees what they pay).
    if (!r.ok || q.total_amount !== r.price || q.currency !== "XTR") {
      await ctx.answerPreCheckoutQuery(false, "این پکیج دیگه معتبر نیست، لطفاً دوباره تلاش کن.");
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  composer.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const chargeId = typeof payment.telegram_payment_charge_id === "string" ? payment.telegram_payment_charge_id : "";
    const resolved = chargeId ? await resolveStarsPayload(payment.invoice_payload) : ({ ok: false, reason: "missing_charge_id" } as Resolved);

    const valid =
      resolved.ok &&
      payment.currency === "XTR" &&
      Number.isInteger(payment.total_amount) &&
      payment.total_amount > 0 &&
      payment.total_amount === resolved.price &&
      Number.isInteger(resolved.relic) &&
      resolved.relic > 0;

    if (!resolved.ok || !valid) {
      // Never credit an amount we cannot verify — but never lose the payment either: keep a durable record
      // (idempotent by charge id) for manual reconciliation and tell the owner. No payload/token is logged.
      const reason = !resolved.ok ? resolved.reason : "amount_or_currency_mismatch";
      console.error("[payments] successful_payment could not be verified; recorded for review:", reason);
      if (chargeId) {
        const firstTime = await recordStarsPaymentException({
          _id: chargeId,
          userId: ctx.from!.id,
          amount: payment.total_amount,
          currency: String(payment.currency),
          reason,
          orderId: "orderId" in resolved ? resolved.orderId : undefined,
        });
        if (firstTime && env.OWNER_ID) {
          await ctx.api
            .sendMessage(env.OWNER_ID, `⚠️ پرداخت Stars تأییدنشده\nکاربر: ${ctx.from!.id}\nمبلغ: ${payment.total_amount} ${payment.currency}\nدلیل: ${reason}\nکد پرداخت: ${chargeId}`)
            .catch(() => {});
        }
      }
      await ctx.reply("پرداختت دریافت شد، ولی نیاز به بررسی دستی داره. به‌زودی با پشتیبانی نتیجه رو اطلاع می‌دیم 🙏").catch(() => {});
      return;
    }

    // Credit exactly what the ORIGINAL order promised. Idempotent by charge id (Telegram retries are safe);
    // any DB error propagates -> webhook answers 500 -> Telegram redelivers -> fulfilment resumes.
    const credited = await creditPurchaseOnce(ctx.from!.id, chargeId, resolved.relic, resolved.price);
    if (resolved.orderId) await markStarsOrderFulfilled(resolved.orderId, chargeId);
    if (!credited) return; // duplicate delivery, already credited

    const relicEmoji = textEmoji("RELIC", "👑");
    await ctx.reply(`✅ ${resolved.relic} ${relicEmoji} XP به حساب شما اضافه شد. ممنون از خریدت 🙏`);
  });
}
