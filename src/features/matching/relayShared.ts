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

  const partnerId = otherParticipant(session, ctx.from!.id);
  if (!partnerId) return null;

  return { session, partnerId };
}
