import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getSession, otherParticipant, endSessionOnce } from "../../db/models/chatSession.js";
import { setActiveChatSession, getUser } from "../../db/models/user.js";
import { refundChatCostOnce } from "../../db/models/relic.js";
import { CHAT_CALLBACKS } from "./constants.js";

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

    await ctx.api.sendMessage(partnerId, ctx.message.text).catch(() => {
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
    const endedText = requireLocked(partnerLang, "matching.chatEndedByPartner", tPartner.matching.chatEndedByPartner)(ender.anonId);
    await ctx.api.sendMessage(partnerId, endedText, { parse_mode: "HTML" }).catch(() => {});

    const refunded = await refundChatCostOnce(partnerId, sessionId);
    if (refunded) {
      const cashbackText = requireLocked(partnerLang, "matching.chatCashback", tPartner.matching.chatCashback);
      await ctx.api.sendMessage(partnerId, cashbackText).catch(() => {});
    }
  });

  // "چت ایمن" — UI stub only, per spec's staged approach; behavior defined
  // in a future prompt. Safely acknowledged by the generic callback
  // fallback (src/bot.ts) in the meantime.
}
