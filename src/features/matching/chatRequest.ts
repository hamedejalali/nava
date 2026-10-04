import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { buttonIcon } from "../../config/emojis.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getUser, type UserDoc } from "../../db/models/user.js";
import { declineChatRequestOnce, type ChatRequestDoc } from "../../db/models/chatRequest.js";
import { acceptChatRequest } from "../../services/chatRequestAccept.js";
import { botApi } from "../../services/miniapp.js";
import { escapeHtml } from "../../utils/html.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { notifyMatch } from "./search.js";
import type { Language } from "../../i18n/index.js";

const ACCEPT_PREFIX = "crq:a:";
const DECLINE_PREFIX = "crq:d:";
const TOKEN_RE = "([A-Za-z0-9_-]{6,24})";

function requestCaption(from: UserDoc): string {
  const name = from.nickname ? escapeHtml(from.nickname) : "یک کاربر";
  const age = from.age ? `، ${from.age} ساله` : "";
  return (
    `💬 <b>درخواست چت</b>\n\n` +
    `${name}${age} از مینی‌اپ نوا می‌خواد باهات چت کنه.\n` +
    `<blockquote>با قبول کردن، از هر دو نفر ۱ رلیک کم میشه و چت ناشناس شروع میشه.</blockquote>`
  );
}

/** Sends the request to the addressee. Returns false when it could not be
 *  delivered (e.g. the user blocked the bot) and closes the request so it
 *  does not stay pending forever. Never throws. */
export async function sendChatRequestToTarget(request: ChatRequestDoc, from: UserDoc, target: UserDoc): Promise<boolean> {
  const reply_markup = inlineKeyboard([
    [
      glassButton("قبول", `${ACCEPT_PREFIX}${request._id}`, "success", buttonIcon("GREEN_CHECK")),
      glassButton("رد", `${DECLINE_PREFIX}${request._id}`, "danger", buttonIcon("BAN")),
    ],
  ]);
  try {
    if (from.profilePhotoFileId) {
      await botApi().sendPhoto(target._id, from.profilePhotoFileId, { caption: requestCaption(from), parse_mode: "HTML", reply_markup });
    } else {
      await botApi().sendMessage(target._id, requestCaption(from), { parse_mode: "HTML", reply_markup });
    }
    return true;
  } catch (err) {
    console.error("[chatRequest] could not deliver request:", err);
    await declineChatRequestOnce(request._id, target._id).catch(() => {});
    return false;
  }
}

export function registerChatRequest(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${DECLINE_PREFIX}${TOKEN_RE}$`), async (ctx) => {
    const token = ctx.match![1]!;
    const declined = await declineChatRequestOnce(token, ctx.from!.id);
    await ctx.answerCallbackQuery({ text: declined ? "رد شد." : "این درخواست دیگه معتبر نیست." });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (declined) {
      await ctx.api.sendMessage(declined.fromId, "😔 درخواست چتت پذیرفته نشد. می‌تونی برای بقیه درخواست بدی.").catch(() => {});
    }
  });

  composer.callbackQuery(new RegExp(`^${ACCEPT_PREFIX}${TOKEN_RE}$`), async (ctx) => {
    const token = ctx.match![1]!;
    const me = ctx.from!.id;
    const result = await acceptChatRequest(token, me);

    if (result.status === "not_pending") {
      await ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (result.status === "busy") {
      await ctx.answerCallbackQuery({ text: "یکی از شما الان توی یه چت دیگه‌ست. بعداً دوباره امتحان کن.", show_alert: true });
      return;
    }
    if (result.status === "blocked") {
      await ctx.answerCallbackQuery({ text: "این درخواست دیگه معتبر نیست.", show_alert: true });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (result.status === "insufficient") {
      if (result.userId === me) {
        await ctx.answerCallbackQuery();
        await ctx.reply("😔 موجودی رلیکت برای شروع چت کافی نیست.", {
          reply_markup: inlineKeyboard([[glassButton("خرید رلیک", MENU_CALLBACKS.relicCoin, "primary", buttonIcon("CROWN"))]]),
        });
      } else {
        await ctx.answerCallbackQuery({ text: "موجودی رلیک طرف مقابل فعلاً کافی نیست.", show_alert: true });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: "✅ چت شروع شد" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

    const other = result.fromId === me ? result.toId : result.fromId;
    const otherUser = await getUser(other);
    const otherLang: Language = otherUser?.languageCode ?? "fa";
    await notifyMatch(ctx, me, ctx.userLang, result.sessionId).catch((e) => console.error("[chatRequest] notify acceptor failed:", e));
    await notifyMatch(ctx, other, otherLang, result.sessionId).catch((e) => console.error("[chatRequest] notify requester failed:", e));
  });
}
