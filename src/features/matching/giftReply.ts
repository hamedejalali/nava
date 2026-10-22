import { isOfficial } from "../../services/nava/common.js";
import type { Composer } from "grammy";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import type { NavaContext } from "../../bot-context.js";
import { buttonIcon } from "../../config/emojis.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getUser } from "../../db/models/user.js";
import { createChatRequest } from "../../db/models/chatRequest.js";
import { col, C } from "../../services/nava/common.js";
import { escapeHtml } from "../../utils/html.js";
import { sendChatRequestToTarget } from "./chatRequest.js";

const REPLY = /^gr:([A-Za-z0-9_-]{6,24})$/;
const CONFIRM = /^grc:([A-Za-z0-9_-]{6,24})$/;

export const GIFT_REPLY_NO_BALANCE_TEXT =
  "💎 برای پیام دادن به فرستنده‌ی هدیه ۱ XP لازمه و موجودی تو الان کافی نیست.\n" +
  "<blockquote>از ربات کیف پول XP بخر و به همین ربات منتقلش کن؛ بعد دوباره روی دکمه بزن.</blockquote>";

/** The gift only counts while the person tapping still OWNS it and it was not sent anonymously. */
async function giftForReply(pub: string, me: number): Promise<{ senderId: number } | null> {
  const g = await (await col<any>(C.gifts)).findOne({ pub, receiverId: me, anonymous: { $ne: true } }, { projection: { senderId: 1 } });
  return g ? { senderId: g.senderId as number } : null;
}

/**
 * "💬 پیام به فرستنده" under a gift notification. Messaging costs 1 Relic per person, exactly like every
 * other chat request: the receiver confirms here, the sender gets the usual accept/decline request, and
 * when they accept BOTH are charged 1 Relic atomically (so nobody pays for a chat that never starts).
 */
export function registerGiftReply(composer: Composer<NavaContext>) {
  composer.callbackQuery(REPLY, async (ctx) => {
    const pub = ctx.match![1]!;
    const me = ctx.from!.id;
    const gift = await giftForReply(pub, me);
    if (!gift) return void (await ctx.answerCallbackQuery({ text: "این هدیه دیگه معتبر نیست.", show_alert: true }));
    const user = await getUser(me);
    if (!user) return void (await ctx.answerCallbackQuery());
    if (user.activeChatSessionId) return void (await ctx.answerCallbackQuery({ text: "الان توی یه چت هستی. اول اون رو تموم کن.", show_alert: true }));
    await ctx.answerCallbackQuery();
    if (!hasUnlimitedXp(user._id) && (user.relicBalance ?? 0) < 1) {
      await ctx.reply(GIFT_REPLY_NO_BALANCE_TEXT, { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(
      "💬 پیام دادن به فرستنده‌ی هدیه ۱ XP هزینه داره.\n<blockquote>یه درخواست چت براش می‌فرستیم؛ اگه قبول کنه از هر دو نفر ۱ XP کم میشه و چت ناشناس شروع میشه. اگه قبول نکنه چیزی کم نمیشه.</blockquote>\nتأیید می‌کنی؟",
      {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([[glassButton("تأیید", `grc:${pub}`, "success", buttonIcon("GREEN_CHECK")), glassButton("انصراف", "grc:no", "danger", buttonIcon("BAN"))]]),
      }
    );
  });

  composer.callbackQuery("grc:no", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "لغو شد." });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  });

  composer.callbackQuery(CONFIRM, async (ctx) => {
    const pub = ctx.match![1]!;
    const me = ctx.from!.id;
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const gift = await giftForReply(pub, me);
    if (!gift) return void (await ctx.answerCallbackQuery({ text: "این هدیه دیگه معتبر نیست.", show_alert: true }));
    const [from, target] = await Promise.all([getUser(me), getUser(gift.senderId)]);
    if (!from || !target || target.banned) return void (await ctx.answerCallbackQuery({ text: "الان نمیشه به این کاربر پیام داد.", show_alert: true }));
    if (isOfficial(target) && (target as any).officialChatOpen !== true) return void (await ctx.answerCallbackQuery({ text: "این اکانت پشتیبانی/حقوقیه و درخواست چت نمی‌گیره.", show_alert: true }));
    if (from.activeChatSessionId) return void (await ctx.answerCallbackQuery({ text: "الان توی یه چت هستی.", show_alert: true }));
    if (!hasUnlimitedXp(from._id) && (from.relicBalance ?? 0) < 1) {
      await ctx.answerCallbackQuery();
      await ctx.reply(GIFT_REPLY_NO_BALANCE_TEXT, { parse_mode: "HTML" });
      return;
    }
    const created = await createChatRequest(me, target._id);
    if (created.status === "already_pending") return void (await ctx.answerCallbackQuery({ text: "قبلاً درخواست دادی؛ منتظر جواب باش.", show_alert: true }));
    if (created.status === "rate_limited") return void (await ctx.answerCallbackQuery({ text: "تعداد درخواست‌هات زیاد شده؛ کمی بعد امتحان کن.", show_alert: true }));
    const delivered = await sendChatRequestToTarget(created.request, from, target);
    await ctx.answerCallbackQuery();
    await ctx.reply(delivered ? `✅ درخواست چت برای ${escapeHtml(target.nickname ?? "فرستنده")} رفت. اگه قبول کنه خبرت می‌کنم.` : "این کاربر الان در دسترس نیست.", { parse_mode: "HTML" });
  });
}
