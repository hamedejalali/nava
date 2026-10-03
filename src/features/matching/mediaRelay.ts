import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { incrementMessageCount } from "../../db/models/chatSession.js";
import { recordRelayedMessage } from "../../db/models/chatRelayMap.js";
import { getActiveSessionAndPartner } from "./relayShared.js";

/**
 * Relays non-text, non-photo media exchanged inside an active anonymous
 * chat: stickers, GIFs/animations, voice notes, videos, video notes, and
 * audio files. Photos are handled separately (see
 * features/photo/chatPhotoModeration.ts) because they go through AI
 * moderation + an admin log channel first.
 *
 * Nothing here is ever stored permanently — Telegram's own `file_id` is
 * simply forwarded on to the partner via the matching `send*` call; no
 * file is downloaded or persisted by this bot for these types.
 *
 * Must be registered in the same relative position as registerChatRelay
 * (after registerChatControls, before generic fallback handlers) — see
 * bot.ts.
 */
export function registerChatMediaRelay(composer: Composer<NavaContext>) {
  composer.on("message:sticker", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendSticker(partnerId, ctx.message.sticker.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });

  composer.on("message:animation", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendAnimation(partnerId, ctx.message.animation.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });

  composer.on("message:voice", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendVoice(partnerId, ctx.message.voice.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });

  composer.on("message:video", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendVideo(partnerId, ctx.message.video.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });

  composer.on("message:video_note", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendVideoNote(partnerId, ctx.message.video_note.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });

  composer.on("message:audio", async (ctx, next) => {
    const resolved = await getActiveSessionAndPartner(ctx);
    if (!resolved) return next();
    const { session, partnerId } = resolved;
    await incrementMessageCount(session._id);
    const sent = await ctx.api
      .sendAudio(partnerId, ctx.message.audio.file_id, { protect_content: session.safeChatEnabled || undefined })
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
  });
}
