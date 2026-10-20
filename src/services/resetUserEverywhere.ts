import { getDb } from "../db/connect.js";
import { resetUserToZero } from "../db/models/user.js";
import { revokeTransferToken } from "./wallet/transferToken.js";
import type { UserDoc } from "../db/models/user.js";

/**
 * "Reset user" = the person starts again from /start AND leaves no trace anywhere in the app:
 *  the bot profile (resetUserToZero), the mini-app username (freed at once so somebody else can take it), the
 *  private-page flag / visibility switches, every post, story, highlight, comment, follow, follow request,
 *  notification, recent search, received gift, pending chat/edit/photo request, and the XP transfer token.
 * Messages the person SENT to others (chats, gifts he gave) stay with their receivers.
 * Each step is independent and idempotent: a failure in one is counted and reported, the rest still run.
 */
export interface ResetReport {
  user: UserDoc | null;
  removed: Record<string, number>;
  failed: string[];
}

export async function resetUserEverywhere(telegramId: number): Promise<ResetReport> {
  const user = await resetUserToZero(telegramId);
  const report: ResetReport = { user, removed: {}, failed: [] };
  if (!user) return report;
  const db = await getDb();

  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      report.removed[name] = await fn();
    } catch {
      report.failed.push(name);
    }
  };
  const del = (collection: string, filter: Record<string, unknown>) => async () => (await db.collection<any>(collection).deleteMany(filter as any)).deletedCount ?? 0;

  await step("users.miniapp_fields", async () => {
    const r = await db.collection<any>("users").updateOne(
      { _id: telegramId },
      { $unset: { miniUsername: "", miniUsernameLower: "", miniUsernameAt: "", isPrivate: "", profileHide: "", navaFollowed: "", miniPhotoAt: "", seedHidden: "" } }
    );
    return r.modifiedCount ?? 0;
  });
  await step("mini_posts", del("mini_posts", { ownerId: telegramId }));
  await step("mini_comments", del("mini_comments", { ownerId: telegramId }));
  await step("mini_stories", del("mini_stories", { ownerId: telegramId }));
  await step("mini_highlights", del("mini_highlights", { ownerId: telegramId }));
  await step("mini_media", del("mini_media", { ownerId: telegramId }));
  await step("mini_follows", del("mini_follows", { $or: [{ followerId: telegramId }, { followeeId: telegramId }] }));
  await step("mini_follow_requests", del("mini_follow_requests", { $or: [{ fromId: telegramId }, { toId: telegramId }] }));
  await step("mini_notifs", del("mini_notifs", { $or: [{ userId: telegramId }, { actorId: telegramId }] }));
  await step("mini_recent_search", del("mini_recent_search", { $or: [{ userId: telegramId }, { ownerId: telegramId }, { viewerId: telegramId }] }));
  await step("mini_gifts", del("mini_gifts", { receiverId: telegramId }));
  await step("chat_requests", del("chat_requests", { $or: [{ fromId: telegramId }, { toId: telegramId }] }));
  await step("edit_requests", del("edit_requests", { telegramId, status: "pending" }));
  await step("image_moderation", del("image_moderation", { senderId: telegramId, status: "pending" }));
  await step("xp_transfer_token", async () => ((await revokeTransferToken(telegramId, "admin")) ? 1 : 0));
  return report;
}
