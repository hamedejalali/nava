import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getAllAdminIds } from "../admin/constants.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getSession, otherParticipant } from "../../db/models/chatSession.js";
import { createModerationRecord, type ImageModerationDoc } from "../../db/models/imageModeration.js";
import { checkImage } from "../../services/sightengine.js";
import { resolveFileUrl } from "../../services/telegramFiles.js";

/** Registered BEFORE the profile-photo upload handler so an in-chat image
 *  is always treated as a chat image, never mistaken for a profile-photo
 *  upload (the profile handler explicitly skips users with an active
 *  session, but ordering here keeps the intent unambiguous either way). */
export function registerChatImageModeration(composer: Composer<NavaContext>) {
  composer.on("message:photo", async (ctx, next) => {
    const sessionId = ctx.dbUser?.activeChatSessionId;
    if (!sessionId) return next(); // not in a chat — handled by the profile-photo uploader

    const session = await getSession(sessionId);
    if (!session || !session.active) return next();

    const partnerId = otherParticipant(session, ctx.from!.id);
    if (!partnerId) return next();

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;

    const fileUrl = await resolveFileUrl(ctx, largest.file_id);
    const check = await checkImage(fileUrl);

    if (!check.flagged) {
      await createModerationRecord({
        type: "chat_image",
        senderId: ctx.from!.id,
        recipientId: partnerId,
        chatSessionId: sessionId,
        fileId: largest.file_id,
        status: "approved",
        aiScore: check.score,
        aiClassification: check.classification,
      });
      await ctx.api.sendPhoto(partnerId, largest.file_id).catch(() => {});
      return;
    }

    // Flagged — block delivery, route to admin. User A is never told
    // *why* beyond a generic notice once decided, and User B never learns
    // an image was even sent (keeps both identities and the moderation
    // process invisible to the other party).
    const record = await createModerationRecord({
      type: "chat_image",
      senderId: ctx.from!.id,
      recipientId: partnerId,
      chatSessionId: sessionId,
      fileId: largest.file_id,
      status: "pending",
      aiScore: check.score,
      aiClassification: check.classification,
    });

    const keyboard = inlineKeyboard([
      [
        glassButton("تأیید ارسال", `modimg:approve:${record._id}`, "success"),
        glassButton("عدم تأیید ارسال", `modimg:reject:${record._id}`, "danger"),
      ],
    ]);

    for (const adminId of await getAllAdminIds()) {
      await ctx.api
        .sendPhoto(adminId, largest.file_id, {
          caption: `📸 عکس مشکوک در چت ناشناس\n\nفرستنده (آیدی تلگرام): ${ctx.from!.id}\nشناسه‌ی چت: ${sessionId}`,
          reply_markup: keyboard,
        })
        .catch(() => {});
    }
  });
}

/** Called by the shared decision handler in photo/moderation.ts once an
 *  admin approves a pending chat_image record. Re-validates the session is
 *  still active and the sender/recipient are still its real participants
 *  before delivering — the chat may have ended while this was pending. */
export async function deliverApprovedChatImage(ctx: NavaContext, doc: ImageModerationDoc): Promise<void> {
  if (!doc.recipientId || !doc.chatSessionId) return;

  const session = await getSession(doc.chatSessionId);
  if (!session || !session.active) return; // chat ended while this was pending — do not deliver

  const isSenderValid = session.userA === doc.senderId || session.userB === doc.senderId;
  const isRecipientValid = otherParticipant(session, doc.senderId) === doc.recipientId;
  if (!isSenderValid || !isRecipientValid) return;

  await ctx.api.sendPhoto(doc.recipientId, doc.fileId).catch(() => {});
}

/** Called by the shared decision handler once an admin rejects a pending
 *  chat_image record — only the sender is told, using generic wording that
 *  reveals nothing about the moderation process or the other party. */
export async function notifyRejectedChatImage(ctx: NavaContext, doc: ImageModerationDoc): Promise<void> {
  await ctx.api.sendMessage(doc.senderId, "🚫 عکسی که فرستادی به دلیل نقض قوانین ربات برای طرف مقابل ارسال نشد.").catch(() => {});
}
