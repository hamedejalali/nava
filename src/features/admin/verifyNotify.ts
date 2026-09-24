import type { Api } from "grammy";
import { env } from "../../config/env.js";
import { textEmoji } from "../../config/emojis.js";
import { getContent } from "../../db/models/content.js";
import { escapeHtml } from "../../utils/html.js";

/**
 * Sends `html` (already escaped, HTML parse mode) to a user, WITH a photo
 * when one is given. If the photo can't be sent (empty/invalid/foreign
 * file_id — a file_id only works for the bot that produced it), the same
 * text is sent as a normal message instead, so the user is never left
 * without a notification (the old code swallowed the error silently).
 */
export async function sendPhotoOrText(api: Api, chatId: number, photo: string | undefined, html: string): Promise<boolean> {
  if (photo) {
    try {
      await api.sendPhoto(chatId, photo, { caption: html, parse_mode: "HTML" });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[verifyNotify] sendPhoto failed, falling back to text:", err);
    }
  }
  try {
    await api.sendMessage(chatId, html, { parse_mode: "HTML" });
    return true;
  } catch {
    return false; // user blocked the bot — nothing else to do
  }
}

/** "You are verified" / "your verification was removed" notice, with photo.
 *  Photos come from VERIFY_APPROVED_PHOTO / VERIFY_REVOKED_PHOTO (env). */
export async function notifyVerificationChange(api: Api, userId: number, nowVerified: boolean): Promise<boolean> {
  if (nowVerified) {
    const html = `✅ شما تایید شدید! ${textEmoji("VERIFIED_BADGE", "🔵")} تیک آبی وریفای به پروفایلتون اضافه شد.`;
    return sendPhotoOrText(api, userId, env.VERIFY_APPROVED_PHOTO, html);
  }

  const supportId = await getContent("supportId", "");
  const supportLine = supportId ? `\n\nاگر اعتراض داری، به آیدی پشتیبانی پیام بده: ${escapeHtml(supportId)}` : "";
  const html = `❌ وریفای پروفایل شما لغو شد و تیک آبی از پروفایلتون برداشته شد.${supportLine}`;
  return sendPhotoOrText(api, userId, env.VERIFY_REVOKED_PHOTO, html);
}
