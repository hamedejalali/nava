import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { BID_PREFIX, JOIN_PREFIX, countEntries, joinGiveaway, placeBid } from "../../services/nava/giftEvents.js";

/** Buttons under the auction / giveaway posts in the channel. The tapper is identified by Telegram itself (ctx.from). */
export function registerGiftEvents(composer: Composer<NavaContext>) {
  const ready = (ctx: NavaContext) => !!ctx.dbUser && ctx.dbUser.onboardingStep === "COMPLETED" && !ctx.dbUser.banned;

  composer.callbackQuery(new RegExp(`^${BID_PREFIX}([A-Za-z0-9_-]{6,24}):(\\d{1,4})$`), async (ctx) => {
    if (!ready(ctx)) return void (await ctx.answerCallbackQuery({ text: "اول ربات رو استارت کن و ثبت‌نامت رو کامل کن.", show_alert: true }));
    const r = await placeBid(ctx.api, ctx.match![1]!, ctx.from!.id, Number(ctx.match![2]));
    const msg: Record<string, string> = {
      closed: "این حراج تموم شده.",
      ended: "زمان این حراج تموم شده.",
      owner: "صاحب حراج نمی‌تونه پیشنهاد بده.",
      already_top: "پیشنهاد تو همین الان بالاترینه.",
      insufficient: "رلیکت برای این پیشنهاد کافی نیست. از ربات کیف پول رلیک بخر و به ربات منتقل کن.",
      not_found: "این حراج پیدا نشد.",
      busy: "همزمان چند نفر پیشنهاد دادن؛ دوباره بزن.",
    };
    if (r.status === "ok") return void (await ctx.answerCallbackQuery({ text: `✅ پیشنهاد ${r.amount} رلیک ثبت شد.`, show_alert: true }));
    await ctx.answerCallbackQuery({ text: msg[r.status] ?? "نشد.", show_alert: true });
  });

  composer.callbackQuery(new RegExp(`^${JOIN_PREFIX}([A-Za-z0-9_-]{6,24})$`), async (ctx) => {
    if (!ready(ctx)) return void (await ctx.answerCallbackQuery({ text: "اول ربات رو استارت کن و ثبت‌نامت رو کامل کن.", show_alert: true }));
    const id = ctx.match![1]!;
    const r = await joinGiveaway(id, ctx.from!.id);
    const text =
      r === "joined" ? `🎉 ثبت شد! تا الان ${await countEntries(id)} نفر شرکت کردن.`
      : r === "already" ? "قبلاً شرکت کردی؛ موفق باشی!"
      : r === "owner" ? "صاحب قرعه‌کشی نمی‌تونه شرکت کنه."
      : r === "closed" ? "این قرعه‌کشی تموم شده."
      : "این قرعه‌کشی پیدا نشد.";
    await ctx.answerCallbackQuery({ text, show_alert: true });
  });
}
