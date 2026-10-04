import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { getRequestRecipientIds, isAdmin } from "../admin/constants.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { incrementMessageCount } from "../../db/models/chatSession.js";
import { recordRelayedMessage } from "../../db/models/chatRelayMap.js";
import {
  createPhotoModerationLog,
  getPhotoModerationLog,
  markPhotoModerationDecided,
} from "../../db/models/photoModerationLog.js";
import { setBanned } from "../../db/models/user.js";
import { checkImage } from "../../services/sightengine.js";
import { resolveFileUrl } from "../../services/telegramFiles.js";
import { getActiveSessionAndPartner } from "../matching/relayShared.js";

const MOD_CALLBACKS = {
  delete: "photomod:delete",
  ban: "photomod:ban",
} as const;

/**
 * REPLACES the old approval-gated "chat_image" flow (features/matching/
 * chatImage.ts, now deleted). A photo sent inside an active anonymous chat
 * is now ALWAYS delivered to the recipient immediately — it is never held
 * back waiting for an admin decision. In parallel, a copy is logged to the
 * moderation log channel (MODERATION_LOG_CHAT_ID, falling back to the
 * owner via getRequestRecipientIds()) with real, server-backed "🗑 حذف" /
 * "🚫 بن فرستنده" actions. The real Sightengine AI check still runs, but
 * purely informationally — its result is attached to the log caption and
 * never blocks or delays delivery, and a failed/unconfigured AI call never
 * blocks delivery either.
 *
 * We deliberately never claim an "AI moderation" system to end users —
 * the log caption uses the honest, generic "سیستم نظارت نوا" wording.
 *
 * Must be registered in the same relative position as the old
 * registerChatImageModeration: before the profile-photo upload handler, so
 * an in-chat photo is never mistaken for a profile-photo upload.
 */
export function registerChatPhotoModeration(composer: Composer<NavaContext>) {
  composer.on("message:photo", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next(); // not in a chat — handled by the profile-photo uploader
    const { session, partnerId } = resolved;

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;

    // Deliver immediately — never gated on moderation.
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendPhoto(partnerId, largest.file_id, { protect_content: session.safeChatEnabled || undefined })
      .catch(() => undefined);

    if (sent) {
      await recordRelayedMessage({
        sessionId: session._id,
        senderId: ctx.from!.id,
        senderMessageId: ctx.message.message_id,
        recipientId: partnerId,
        recipientMessageId: sent.message_id,
      });
    }

    // Run the real AI check informationally. Any failure here (including
    // an unconfigured service) must never affect delivery, which already
    // happened above.
    let aiFlagged: boolean | undefined;
    let aiScore: number | undefined;
    let aiClassification: string | undefined;
    try {
      const fileUrl = await resolveFileUrl(ctx, largest.file_id);
      const check = await checkImage(fileUrl);
      aiFlagged = check.flagged;
      aiScore = check.score;
      aiClassification = check.classification;
    } catch {
      // Service unreachable — log without an AI verdict rather than
      // falsely claiming one.
    }

    const log = await createPhotoModerationLog({
      senderTelegramId: ctx.from!.id,
      receiverTelegramId: partnerId,
      senderMessageId: ctx.message.message_id,
      receiverMessageId: sent?.message_id ?? ctx.message.message_id,
      chatSessionId: session._id,
      fileId: largest.file_id,
      aiFlagged,
      aiScore,
      aiClassification,
    });

    const logChatIds = env.MODERATION_LOG_CHAT_ID ? [env.MODERATION_LOG_CHAT_ID] : await getRequestRecipientIds();
    const flagLine =
      aiFlagged === undefined
        ? "سیستم نظارت نوا: بررسی ناموفق (سرویس در دسترس نبود)"
        : aiFlagged
          ? `سیستم نظارت نوا: مشکوک (امتیاز ${aiScore?.toFixed(2) ?? "?"} / ${aiClassification ?? "?"})`
          : `سیستم نظارت نوا: بدون مورد مشکوک (امتیاز ${aiScore?.toFixed(2) ?? "?"})`;

    const caption =
      `📸 عکس ارسالی در چت ناشناس (تحویل داده شد)\n\n` +
      `فرستنده (آیدی تلگرام): ${ctx.from!.id}\n` +
      `گیرنده (آیدی تلگرام): ${partnerId}\n` +
      `شناسه‌ی چت: ${session._id}\n` +
      `${flagLine}`;

    const keyboard = inlineKeyboard([
      [
        glassButton("🗑 حذف", `${MOD_CALLBACKS.delete}:${log._id}`, "danger"),
        glassButton("🚫 بن فرستنده", `${MOD_CALLBACKS.ban}:${log._id}`, "danger"),
      ],
    ]);

    for (const chatId of logChatIds) {
      await ctx.api.sendPhoto(chatId, largest.file_id, { caption, reply_markup: keyboard }).catch(() => {});
    }
  });

  composer.callbackQuery(/^photomod:delete:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    // Defence in depth (v1.9.0): these buttons are only ever sent to the
    // owner/admins, but the action itself must not depend on that alone.
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    const result = await markPhotoModerationDecided(id, "deleted", ctx.from!.id);

    if (result.status === "not_found") {
      await ctx.reply("رکورد پیدا نشد.").catch(() => {});
      return;
    }
    // "already_decided" and fresh "decided" both end up showing the same
    // confirmation — the delete attempts below are a safe no-op either way
    // since Telegram itself will simply fail silently on an already-gone
    // message, and we don't re-warn the sender twice.
    const doc = result.doc;

    if (result.status === "decided") {
      await ctx.api.deleteMessage(doc.receiverTelegramId, doc.receiverMessageId).catch(() => {});
      await ctx.api
        .sendMessage(doc.senderTelegramId, "🚫 عکسی که فرستادی به دلیل نقض قوانین ربات حذف شد.")
        .catch(() => {});
    }

    await ctx.editMessageCaption({ caption: `${(ctx.callbackQuery.message as any)?.caption ?? ""}\n\n✅ حذف شد.` }).catch(() => {});
  });

  composer.callbackQuery(/^photomod:ban:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx)) return; // see the note on the delete handler
    const id = ctx.match![1]!;
    const doc = await getPhotoModerationLog(id);
    if (!doc) {
      await ctx.reply("رکورد پیدا نشد.").catch(() => {});
      return;
    }

    const result = await markPhotoModerationDecided(id, "sender_banned", ctx.from!.id);
    if (result.status === "decided") {
      await setBanned(doc.senderTelegramId, true, "عکس نامناسب در چت ناشناس");
      await ctx.api.sendMessage(doc.senderTelegramId, "🚫 دسترسی شما به ربات به دلیل ارسال عکس نامناسب مسدود شد.").catch(() => {});
    }

    await ctx.editMessageCaption({ caption: `${(ctx.callbackQuery.message as any)?.caption ?? ""}\n\n🚫 فرستنده بن شد.` }).catch(() => {});
  });
}
