import type { NavaContext } from "../../bot-context.js";
import { getSession, otherParticipant, type ChatSessionDoc } from "../../db/models/chatSession.js";
import { setActiveChatSession } from "../../db/models/user.js";

/**
 * Shared "is this user actually in a live chat, and who's the partner"
 * check — used identically by text relay, media relay, and photo
 * moderation, so the active-session validation logic lives in exactly one
 * place instead of being copy-pasted (and potentially drifting) across
 * three handlers.
 *
 * Clears a stale `activeChatSessionId` pointer defensively (mirrors the
 * original inline logic in chat.ts) when the session doc no longer exists
 * or is no longer active, then returns null so the caller falls through to
 * `next()` and treats the message as a normal (non-chat) message.
 */
export async function getActiveSessionAndPartner(
  ctx: NavaContext
): Promise<{ session: ChatSessionDoc; partnerId: number } | null> {
  const sessionId = ctx.dbUser?.activeChatSessionId;
  if (!sessionId) return null;

  const session = await getSession(sessionId);
  if (!session || !session.active) {
    await setActiveChatSession(ctx.from!.id, undefined);
    return null;
  }

  // A Navagram (Mini App) direct-message chat is NOT relayed through the bot: its messages live in the app.
  if (session.origin === "miniapp") return null;

  const partnerId = otherParticipant(session, ctx.from!.id);
  if (!partnerId) return null;

  return { session, partnerId };
}

export const MINIAPP_CHAT_HINT = "💬 چتت داخل نوا گرام (بخش «پیام‌ها» توی مینی‌اپ) جریان داره؛ پیام‌ها رو از اونجا بفرست.\nبرای پایان دادن به چت هم /end رو بفرست.";

/** True when this person is in a Navagram direct-message chat (so a bot message must not be treated as chat text). */
export async function inMiniappChat(ctx: NavaContext): Promise<boolean> {
  const sessionId = ctx.dbUser?.activeChatSessionId;
  if (!sessionId) return false;
  const session = await getSession(sessionId);
  return !!session && session.active && session.origin === "miniapp";
}

/** Install BEFORE the photo / media relays: a photo or sticker sent to the bot during an in-app chat is not a profile
 *  upload and not a relay — the person is pointed back to the app. */
export function registerMiniappChatGuard(composer: import("grammy").Composer<NavaContext>, hasPendingPhotoFlow: (id: number) => Promise<boolean>) {
  composer.on(["message:photo", "message:sticker", "message:animation", "message:voice", "message:video", "message:video_note", "message:audio"], async (ctx, next) => {
    if (!(await inMiniappChat(ctx))) return next();
    if (await hasPendingPhotoFlow(ctx.from!.id)) return next();
    await ctx.reply(MINIAPP_CHAT_HINT).catch(() => {});
  });
}
