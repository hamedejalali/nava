import type { Api, Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { buttonIcon, textEmoji } from "../../config/emojis.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getUser, type UserDoc } from "../../db/models/user.js";
import { getRelicBalance } from "../../db/models/relic.js";
import { createReveal, getReveal, payReveal } from "../../db/models/profileReveal.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { buildProfileKeyboard, replyWithProfile } from "./profile.js";

/**
 * Paid "who looked at my profile?" flow.
 *
 * Trigger: user 1 (NOT in a chat) sends user 2's Nava ID to the bot. User 1
 * gets user 2's profile exactly as before. User 2 gets an ANONYMOUS notice
 * ("someone viewed your profile") with a glass "پرداخت" button. If user 2
 * pays PROFILE_VIEW_REVEAL_COST Relic (default 10), user 1's profile is
 * shown to user 2. Not enough Relic => a "not enough balance" message with a
 * shortcut to the Relic shop.
 */

const REVEAL_CB_PREFIX = "pvreveal:";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function toPersianDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]!);
}

function notificationText(cost: number): string {
  const nava = textEmoji("NAVA", "🌐");
  return (
    "پیام ربات 👇\n\n" +
    `کاربری پروفایلِ ${nava}نوا${nava}  شما را مشاهده کرد.\n\n` +
    "<blockquote>⚠️ توجه: پروفایل نوا اطلاعاتی است که در بخش پروفایل ربات ثبت کرده اید!</blockquote>\n" +
    `شما میتوانید با پرداخت ${toPersianDigits(cost)} رلیک اطلاعات کاربری که پروفایل شما را مشاهده کرده را ببینید`
  );
}

/** Sends the anonymous "someone viewed you" notice with the pay button to
 *  `target`. Never throws (the target may have blocked the bot). */
export async function sendRevealNotification(api: Api, viewerId: number, target: UserDoc): Promise<void> {
  try {
    const revealId = await createReveal(viewerId, target._id);
    await api.sendMessage(target._id, notificationText(env.PROFILE_VIEW_REVEAL_COST), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([[glassButton("پرداخت", `${REVEAL_CB_PREFIX}${revealId}`, "success", buttonIcon("RELIC"))]]),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[profileReveal] could not send reveal notification:", err);
  }
}

export function registerProfileReveal(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${REVEAL_CB_PREFIX}([A-Za-z0-9_-]{6,40})$`), async (ctx) => {
    const revealId = ctx.match![1]!;
    const payerId = ctx.from!.id;
    const cost = env.PROFILE_VIEW_REVEAL_COST;

    const reveal = await getReveal(revealId);
    if (!reveal || reveal.targetId !== payerId) {
      await ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
      return;
    }

    // Check the viewer still exists BEFORE charging anything.
    const viewer = await getUser(reveal.viewerId);
    if (!viewer) {
      await ctx.answerCallbackQuery({ text: "این کاربر دیگه در دسترس نیست.", show_alert: true });
      return;
    }

    const result = await payReveal(revealId, payerId, cost);

    if (result.status === "not_found") {
      await ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
      return;
    }

    if (result.status === "insufficient") {
      await ctx.answerCallbackQuery();
      const balance = await getRelicBalance(payerId);
      await ctx.reply(
        `😔 موجودی رلیک شما کافی نیست!\n\n` +
          `برای دیدن اطلاعات کاربری که پروفایلت رو مشاهده کرده به ${toPersianDigits(cost)} رلیک نیاز داری.\n` +
          `موجودی فعلی شما: ${toPersianDigits(balance)} رلیک\n\n` +
          `بعد از شارژ حساب، دوباره روی دکمه‌ی «پرداخت» پیام بالا بزن 👆`,
        {
          reply_markup: inlineKeyboard([[glassButton("خرید رلیک", MENU_CALLBACKS.relicCoin, "primary", buttonIcon("CROWN"))]]),
        }
      );
      return;
    }

    // paid, or already paid earlier (re-tap: show it again, no new charge)
    await ctx.answerCallbackQuery({ text: result.status === "paid" ? "✅ پرداخت انجام شد" : "قبلاً پرداخت شده بود" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

    await replyWithProfile(ctx, viewer, ctx.dbUser, buildProfileKeyboard(ctx.userLang, viewer, "lookup"));
  });
}
