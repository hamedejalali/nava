import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";

export const ADMIN_CALLBACKS = {
  openGuideMenu: "admin:guides",
  editGuideText: "admin:guides:text",
  editGuide1: "admin:guides:guide1",
  editPinnedPromo: "admin:guides:pinnedpromo",
  editRules: "admin:guides:rules",
  editSupportId: "admin:support_id",
  cancelEdit: "admin:cancel",
} as const;

export function isOwner(ctx: NavaContext): boolean {
  const id = ctx.from?.id;
  if (!id || env.OWNER_ID === undefined) return false;
  return id === env.OWNER_ID;
}

/** True for the owner, any statically-configured ADMIN_IDS, or anyone the
 *  owner has dynamically granted admin status to via the Moderator/Admin
 *  management screen (ctx.dbUser.isAdmin — already loaded by the context
 *  middleware, so this stays a cheap synchronous check everywhere). */
export function isAdmin(ctx: NavaContext): boolean {
  const id = ctx.from?.id;
  if (!id) return false;
  if (isOwner(ctx)) return true;
  if (env.ADMIN_IDS.includes(id)) return true;
  return !!ctx.dbUser?.isAdmin;
}

/** All admin Telegram IDs (owner + static ADMIN_IDS + dynamically-granted
 *  DB admins) — for broadcasting a notification to every admin at once. */
export async function getAllAdminIds(): Promise<number[]> {
  const { getDb } = await import("../../db/connect.js");
  const db = await getDb();
  const dynamicAdmins = await db
    .collection<any>("users")
    .find({ isAdmin: true }, { projection: { _id: 1 } })
    .toArray();

  const ids = new Set<number>(env.ADMIN_IDS);
  if (env.OWNER_ID !== undefined) ids.add(env.OWNER_ID);
  for (const d of dynamicAdmins) ids.add(d._id);
  return [...ids];
}
