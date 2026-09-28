import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getSession, otherParticipant, endSessionOnce, incrementMessageCount, toggleSafeChat } from "../../db/models/chatSession.js";
import { setActiveChatSession, getUser } from "../../db/models/user.js";
import { refundChatCostOnce } from "../../db/models/relic.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { textEmoji } from "../../config/emojis.js";
import { buildChatControlsKeyboard } from "./chatUi.js";

/** Every text message from a user with an active chat session is relayed
 *  verbatim to their partner, never touching any onboarding/admin handler.
 *  Must be registered before those so an in-chat message can never be
 *  misread as onboarding input (e.g. a stray "23" being read as an age). */
export function registerChatRelay(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) return next();

    const session = await getSession(sessionId);
    if (!session || !session.active) {
      // Stale pointer (session already ended some other way) — clear it
      // defensively and let the message fall through normally.
      await setActiveChatSession(ctx.from!.id, undefined);
      return next();
    }

    const partnerId = otherParticipant(session, ctx.from!.id);
    if (!partnerId) return next();

    await incrementMessageCount(session._id);

    await ctx.api
      .sendMessage(partnerId, ctx.message.text, {
        // "چت ایمن": while enabled, relayed messages can't be forwarded or
        // saved by the recipient. Telegram has no way for a bot to detect
        // or block a screenshot itself — protect_content is the actual,
        // real effect available through the Bot API.
        protect_content: session.safeChatEnabled || undefined,
      })
      .catch(() => {
        // Partner may have blocked the bot or deleted their account — the
        // chat itself stays open; message delivery failures are silent to
        // the sender by design (mirrors how Telegram DMs behave).
      });
  });
}

async function showEndChatConfirm(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "matching.endChatConfirm", t.matching.endChatConfirm);
  const continueLabel = requireLocked(lang, "matching.continueChatButton", t.matching.continueChatButton);
  const endLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton);

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard([
      [
        glassButton(continueLabel, CHAT_CALLBACKS.endChatCancel, "success"),
        glassButton(endLabel, CHAT_CALLBACKS.endChatConfirm, "danger"),
      ],
    ]),
  });
}

export function registerChatControls(composer: Composer<NavaContext>) {
  composer.callbackQuery(CHAT_CALLBACKS.endChat, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.dbUser?.activeChatSessionId) return; // nothing active, ignore
    await showEndChatConfirm(ctx, ctx.userLang);
  });

  composer.callbackQuery(CHAT_CALLBACKS.endChatCancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  // "چت ایمن" / "غیرفعال کردن چت ایمن" — same button, callback data never
  // changes; the label flips based on the session's current state. Either
  // participant can toggle it; it applies to the whole session (both
  // directions), and both sides' own copy of this message gets its label
  // updated so neither side sees a stale state.
  composer.callbackQuery(CHAT_CALLBACKS.safeChat, async (ctx) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = await toggleSafeChat(sessionId);
    if (!result) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { session, enabled } = result;
    await ctx.answerCallbackQuery({ text: enabled ? "🔒 چت ایمن فعال شد" : "🔓 چت ایمن غیرفعال شد" });

    const partnerId = otherParticipant(session, ctx.from!.id);
    const partner = partnerId ? await getUser(partnerId) : null;
    const partnerLang: Language = partner?.languageCode ?? "fa";

    const edits: Array<Promise<unknown>> = [
      ctx
        .editMessageReplyMarkup({ reply_markup: buildChatControlsKeyboard(ctx.userLang, enabled) })
        .catch(() => {}),
    ];
    if (partnerId) {
      const partnerMessageId = session.userA === partnerId ? session.controlsMessageIdA : session.controlsMessageIdB;
      if (partnerMessageId) {
        edits.push(
          ctx.api
            .editMessageReplyMarkup(partnerId, partnerMessageId, { reply_markup: buildChatControlsKeyboard(partnerLang, enabled) })
            .catch(() => {})
        );
      }
    }
    await Promise.all(edits);
  });

  composer.callbackQuery(CHAT_CALLBACKS.endChatConfirm, async (ctx) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result = await endSessionOnce(sessionId, ctx.from!.id);
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});

    if (result.status !== "ended") return; // already ended (duplicate tap) — nothing more to do

    const { session } = result;
    const partnerId = otherParticipant(session, ctx.from!.id)!;

    // Clear both sides' "in an active chat" pointer.
    await setActiveChatSession(session.userA, undefined);
    await setActiveChatSession(session.userB, undefined);

    // The user who tapped "پایان چت" gets no refund; the OTHER user does.
    const ender = ctx.dbUser!;
    const partner = await getUser(partnerId);
    const partnerLang: Language = partner?.languageCode ?? "fa";

    const tPartner = dictionary(partnerLang);
    const endedTemplate = requireLocked(partnerLang, "matching.chatEndedByPartner", tPartner.matching.chatEndedByPartner)(ender.anonId);
    const navaEmoji = textEmoji("NAVA", "🌐");
    const endedText = endedTemplate.split("{{NAVA_EMOJI}}").join(navaEmoji);
    await ctx.api
      .sendMessage(partnerId, endedText, {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([[glassButton("🚫 گزارش کاربر", `${CHAT_CALLBACKS.report}:${ender._id}`, "danger")]]),
      })
      .catch(() => {});

    // Refund only applies to a chat that never really got going: fewer
    // than 4 messages total between BOTH participants. A chat with real
    // conversation doesn't get the 1-Relic cashback even though the OTHER
    // person ended it.
    const totalMessages = session.messageCount ?? 0;
    if (totalMessages < 4) {
      const refunded = await refundChatCostOnce(partnerId, sessionId);
      if (refunded) {
        const relicEmoji = textEmoji("RELIC", "💰");
        const cashbackTemplate = requireLocked(partnerLang, "matching.chatCashback", tPartner.matching.chatCashback);
        const cashbackText = cashbackTemplate.split("{{RELIC_EMOJI}}").join(relicEmoji);
        await ctx.api.sendMessage(partnerId, cashbackText).catch(() => {});
      }
    }

    // Ending a chat previously left BOTH sides with no inline keyboard at
    // all on-screen (the confirm dialog was deleted, and none of the
    // messages above carry buttons), forcing a fresh /start just to get
    // any tappable button back. Re-show the main menu keyboard to both
    // participants so they can immediately act again.
    const chooseFromMenuText = requireLocked(partnerLang, "onboarding.chooseFromMenu", tPartner.onboarding.chooseFromMenu);
    await ctx.api.sendMessage(partnerId, chooseFromMenuText, { reply_markup: buildMainMenuReplyKeyboard(partnerLang) }).catch(() => {});

    const tEnder = dictionary(ctx.userLang);
    const chooseFromMenuTextEnder = requireLocked(ctx.userLang, "onboarding.chooseFromMenu", tEnder.onboarding.chooseFromMenu);
    await ctx.reply(chooseFromMenuTextEnder, { reply_markup: buildMainMenuReplyKeyboard(ctx.userLang) }).catch(() => {});
  });
}
