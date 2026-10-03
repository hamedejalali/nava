import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { otherParticipant, endSessionOnce, incrementMessageCount, toggleSafeChat } from "../../db/models/chatSession.js";
import { setActiveChatSession, getUser } from "../../db/models/user.js";
import { refundChatCostOnce } from "../../db/models/relic.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { buildMainMenuReplyKeyboard, matchMainMenuAction } from "../menu/mainMenu.js";
import { textEmoji } from "../../config/emojis.js";
import { buildChatControlsKeyboard, matchChatControlAction } from "./chatUi.js";
import { showPartnerProfile } from "./profile.js";
import { getActiveSessionAndPartner } from "./relayShared.js";
import { recordRelayedMessage } from "../../db/models/chatRelayMap.js";

/** Every text message from a user with an active chat session is relayed
 *  verbatim to their partner, never touching any onboarding/admin handler.
 *  Must be registered before those so an in-chat message can never be
 *  misread as onboarding input (e.g. a stray "23" being read as an age).
 *
 *  IMPORTANT: this must run AFTER registerChatControls (see bot.ts) — the
 *  three chat-control buttons are now reply-keyboard text labels (see
 *  chatUi.ts), not inline callback buttons, so their exact text has to be
 *  intercepted here BEFORE it would otherwise be relayed as a normal
 *  message to the partner. */
export function registerChatRelay(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;

    await incrementMessageCount(session._id);

    const sent = await ctx.api
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
        return undefined;
      });

    if (sent) {
      // Record the id mapping so a real reaction the recipient leaves on
      // their copy of this message can be mirrored onto the sender's own
      // copy (see features/matching/reactions.ts). Never stores content.
      await recordRelayedMessage({
        sessionId: session._id,
        senderId: ctx.from!.id,
        senderMessageId: ctx.message.message_id,
        recipientId: partnerId,
        recipientMessageId: sent.message_id,
      });
    }
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

async function doEndChat(ctx: NavaContext) {
  const sessionId = ctx.dbUser?.activeChatSessionId;
  if (!sessionId) return;

  const result = await endSessionOnce(sessionId, ctx.from!.id);
  if (result.status !== "ended") return; // already ended (duplicate tap) — nothing more to do

  const { session } = result;
  const partnerId = otherParticipant(session, ctx.from!.id)!;

  // Clear both sides' "in an active chat" pointer.
  await setActiveChatSession(session.userA, undefined);
  await setActiveChatSession(session.userB, undefined);

  // The user who ended the chat gets no refund; the OTHER user does.
  const ender = ctx.dbUser!;
  const partner = await getUser(partnerId);
  const partnerLang: Language = partner?.languageCode ?? "fa";

  const tPartner = dictionary(partnerLang);
  const endedTemplate = requireLocked(partnerLang, "matching.chatEndedByPartner", tPartner.matching.chatEndedByPartner)(ender.anonId);
  const navaEmoji = textEmoji("NAVA", "🌐");
  const endedText = endedTemplate.split("{{NAVA_EMOJI}}").join(navaEmoji);
  // "گزارش کاربر" only ever appears once the chat is OVER — see
  // buildProfileKeyboard's "chat" branch for why it's hidden while still
  // connected.
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

  // Ending a chat previously left BOTH sides with no keyboard at all
  // on-screen, forcing a fresh /start just to get any tappable button
  // back. Re-show the main menu keyboard to both participants so they can
  // immediately act again — this also REPLACES the chat-controls reply
  // keyboard that was showing until now.
  const chooseFromMenuText = requireLocked(partnerLang, "onboarding.chooseFromMenu", tPartner.onboarding.chooseFromMenu);
  await ctx.api.sendMessage(partnerId, chooseFromMenuText, { reply_markup: buildMainMenuReplyKeyboard(partnerLang) }).catch(() => {});

  const tEnder = dictionary(ctx.userLang);
  const chooseFromMenuTextEnder = requireLocked(ctx.userLang, "onboarding.chooseFromMenu", tEnder.onboarding.chooseFromMenu);
  await ctx.reply(chooseFromMenuTextEnder, { reply_markup: buildMainMenuReplyKeyboard(ctx.userLang) }).catch(() => {});
}

/** CHANGED (v1.7.0): the three in-chat controls ("مشاهده پروفایل",
 *  "چت ایمن"/"غیرفعال کردن چت ایمن", "پایان چت") are now a persistent
 *  reply keyboard (see chatUi.ts) instead of inline glass buttons, so they
 *  arrive here as plain text, not callback_query updates. This handler
 *  MUST be registered before registerChatRelay (see bot.ts) so a tap on
 *  one of them is never relayed to the partner as an ordinary message. A
 *  tap while NOT in an active chat (a stale/leftover keyboard) falls
 *  through to `next()` untouched. */
export function registerChatControls(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) return next();
    // A real main-menu tap always wins, even while the old keyboard is
    // still visually on screen for a moment (e.g. right after the chat
    // ended on the OTHER side but this client hasn't refreshed yet).
    if (matchMainMenuAction(ctx.message.text.trim())) return next();

    const action = matchChatControlAction(ctx.message.text.trim(), ctx.userLang);
    if (!action) return next();

    if (action === "endChat") {
      await showEndChatConfirm(ctx, ctx.userLang);
      return;
    }

    if (action === "partnerProfile") {
      await showPartnerProfile(ctx);
      return;
    }

    // action === "safeChat" — toggles for the WHOLE session; either
    // participant can flip it. Reply keyboards can't be edited in place
    // (unlike inline ones), so refreshing the visible label on both sides
    // means sending each of them a short new message carrying the updated
    // keyboard — Telegram then shows that as the active bottom keyboard.
    const result = await toggleSafeChat(sessionId);
    if (!result) return;
    const { session, enabled } = result;

    const partnerId = otherParticipant(session, ctx.from!.id);
    const partner = partnerId ? await getUser(partnerId) : null;
    const partnerLang: Language = partner?.languageCode ?? "fa";

    await ctx.reply(enabled ? "🔒 چت ایمن فعال شد." : "🔓 چت ایمن غیرفعال شد.", {
      reply_markup: buildChatControlsKeyboard(ctx.userLang, enabled),
    });
    if (partnerId) {
      await ctx.api
        .sendMessage(partnerId, enabled ? "🔒 مخاطبت چت ایمن رو فعال کرد." : "🔓 مخاطبت چت ایمن رو غیرفعال کرد.", {
          reply_markup: buildChatControlsKeyboard(partnerLang, enabled),
        })
        .catch(() => {});
    }
  });

  composer.callbackQuery(CHAT_CALLBACKS.endChatCancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  composer.callbackQuery(CHAT_CALLBACKS.endChatConfirm, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await doEndChat(ctx);
  });
}
