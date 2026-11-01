import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { textEmoji } from "../../config/emojis.js";
import { creditStarsPaymentOnce } from "../../db/models/relic.js";
import { getPackages } from "../../db/models/pricing.js";
import { env } from "../../config/env.js";
import { getOrCreateStarsOrder, getStarsOrder, recordStarsPaymentException, type StarsOrderDoc } from "../../db/models/starsOrder.js";


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
async function resolveStarsPayload(payload: string, opts: { requirePending?: boolean } = {}): Promise<Resolved> {
  const orderId = decodeOrderId(payload);
  if (orderId) {
    const order: StarsOrderDoc | null = await getStarsOrder(orderId);
    if (!order) return { ok: false, reason: "unknown_order", orderId };
    if (opts.requirePending && order.status !== "pending") return { ok: false, reason: "order_already_fulfilled", orderId };
    return { ok: true, relic: order.relic, price: order.price, orderId };
  }
  const index = decodeIndex(payload);
  if (index === null) return { ok: false, reason: "bad_payload" };
  const pkg = (await getPackages("stars"))[index];
  if (!pkg) return { ok: false, reason: "legacy_package_missing" };
  return { ok: true, relic: pkg.relic, price: pkg.price };
}

export { showRelicScreen } from "../shop/shop.js";

export function registerStarsCheckout(composer: Composer<NavaContext>) {
  composer.on("pre_checkout_query", async (ctx) => {
    const q = ctx.preCheckoutQuery;
    const r = await resolveStarsPayload(q.invoice_payload, { requirePending: true }); // an order that was already paid cannot be paid again
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

    // Credit exactly what the ORIGINAL order promised — atomically claiming the order, so ONE order can be paid out ONCE
    // (a forwarded invoice: the first valid payer gets it). Idempotent by charge id (Telegram retries are safe);
    // any DB error propagates -> webhook answers 500 -> Telegram redelivers -> fulfilment resumes.
    const outcome = await creditStarsPaymentOnce({ orderId: resolved.orderId, userId: ctx.from!.id, chargeId, relic: resolved.relic, stars: resolved.price });
    if (outcome === "duplicate") return; // duplicate delivery, already credited
    if (outcome === "order_consumed") {
      // a REAL payment for an order that was already fulfilled by another charge: nothing is credited, evidence is kept for manual refund/reconciliation
      const firstTime = await recordStarsPaymentException({ _id: chargeId, userId: ctx.from!.id, amount: payment.total_amount, currency: String(payment.currency), reason: "order_already_fulfilled", orderId: resolved.orderId });
      if (firstTime && env.OWNER_ID) {
        await ctx.api.sendMessage(env.OWNER_ID, `⚠️ پرداخت Stars برای سفارشِ قبلاً تسویه‌شده\nکاربر: ${ctx.from!.id}\nمبلغ: ${payment.total_amount} ${payment.currency}\nکد پرداخت: ${chargeId}\nاعتباری داده نشد؛ نیاز به بررسی/بازپرداخت دستی.`).catch(() => {});
      }
      await ctx.reply("پرداختت دریافت شد، ولی این فاکتور قبلاً پرداخت شده بود و ژتونی اضافه نشد. پشتیبانی بررسی می‌کنه 🙏").catch(() => {});
      return;
    }

    const relicEmoji = textEmoji("RELIC", "👑");
    await ctx.reply(`✅ ${resolved.relic} ${relicEmoji} ژتون به حساب شما اضافه شد. ممنون از خریدت 🙏`);
  });
}
