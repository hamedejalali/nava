import { sendOfficialMessage } from "./dm.js";
import type { Api } from "grammy";
import { env } from "../../config/env.js";
import { cleanBadges } from "../../config/badges.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { setVerified } from "../../db/models/user.js";
import { banUser, unbanUser } from "../banCleanup.js";
import { notifyVerificationChange } from "../../features/admin/verifyNotify.js";
import { SocialError, isAnonId, isStaffId, usersCol } from "./common.js";

/**
 * Staff (owner + admins) moderation from INSIDE the Mini App — the same functions the bot's admin panel uses
 * (banUser / unbanUser / setVerified), so both surfaces always agree: one ban flag, one verified flag, one badge list.
 */
export type StaffOp = "ban" | "unban" | "verify" | "unverify" | "photo_remove" | "badges";

export interface StaffResult {
  banned: boolean;
  verified: boolean;
  badges: string[];
  hasPhoto: boolean;
}

export async function staffModerate(staffId: number, anonId: unknown, op: StaffOp, api: Pick<Api, "sendMessage">, extra: { badges?: unknown; reason?: unknown } = {}): Promise<StaffResult> {
  if (!isStaffId(staffId) && !(await isDbAdmin(staffId))) throw new SocialError("forbidden");
  if (!isAnonId(anonId)) throw new SocialError("not_found");
  const users = await usersCol();
  const target: any = await users.findOne({ anonId });
  if (!target) throw new SocialError("not_found");
  const staffIsOwner = env.OWNER_ID !== undefined && staffId === env.OWNER_ID;
  // nobody touches the owner; only the owner touches other admins
  if (env.OWNER_ID !== undefined && target._id === env.OWNER_ID && op !== "badges" && op !== "verify" && op !== "unverify") throw new SocialError("forbidden");
  if (!staffIsOwner && target._id !== staffId && (isStaffId(target._id) || target.isAdmin === true) && (op === "ban" || op === "photo_remove")) throw new SocialError("forbidden");

  const id = target._id as number;
  switch (op) {
    case "ban": {
      const reason = typeof extra.reason === "string" && extra.reason.trim() ? extra.reason.trim().slice(0, 120) : "توسط ادمین";
      await banUser(api, id, reason);
      await logAdminAction(staffId, "ban_user", String(id));
      break;
    }
    case "unban":
      await unbanUser(api, id);
      await logAdminAction(staffId, "unban_user", String(id));
      break;
    case "verify":
    case "unverify": {
      const want = op === "verify";
      if (!!target.verified !== want) {
        await setVerified(id, want);
        await logAdminAction(staffId, "toggle_verify", String(id));
        await notifyVerificationChange(api as any, id, want).catch(() => {});
      }
      break;
    }
    case "photo_remove":
      await users.updateOne({ _id: id }, { $unset: { profilePhotoFileId: "", profilePhotoAt: "" } });
      await logAdminAction(staffId, "miniapp_photo_remove", String(id));
    {
      const why = typeof extra.reason === "string" && extra.reason.trim() ? `\nدلیل: ${extra.reason.trim().slice(0, 200)}` : "";
      const note = "⚠️ عکس پروفایلت به‌خاطر نقض قوانین توسط مدیریت حذف شد. می‌تونی عکس جدیدی بذاری." + why;
      if (env.OWNER_ID !== undefined && id !== env.OWNER_ID) await sendOfficialMessage(api as any, env.OWNER_ID, id, note).catch(() => api.sendMessage(id, note).catch(() => {}));
      else await api.sendMessage(id, note).catch(() => {});
    }
      break;
    case "badges":
      await users.updateOne({ _id: id }, { $set: { badges: cleanBadges(extra.badges) } });
      await logAdminAction(staffId, "set_badges", `${id}:${cleanBadges(extra.badges).join(",")}`);
      break;
  }
  const fresh: any = await users.findOne({ _id: id });
  return { banned: !!fresh?.banned, verified: !!fresh?.verified, badges: cleanBadges(fresh?.badges), hasPhoto: !!fresh?.profilePhotoFileId };
}

async function isDbAdmin(id: number): Promise<boolean> {
  const u: any = await (await usersCol()).findOne({ _id: id }, { projection: { isAdmin: 1, banned: 1 } });
  return !!u && u.isAdmin === true && !u.banned;
}

/** Owner-style assignment by numeric Telegram id (admin panel «🏅 بج‌ها»). */
export async function setBadgesById(staffId: number, userId: number, badges: unknown): Promise<string[] | null> {
  const users = await usersCol();
  const t: any = await users.findOne({ _id: userId });
  if (!t) return null;
  const clean = cleanBadges(badges);
  await users.updateOne({ _id: userId }, { $set: { badges: clean } });
  await logAdminAction(staffId, "set_badges", `${userId}:${clean.join(",")}`);
  return clean;
}
