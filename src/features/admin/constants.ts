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

export function isAdmin(ctx: NavaContext): boolean {
  const id = ctx.from?.id;
  if (!id) return false;
  return env.ADMIN_IDS.includes(id);
}
