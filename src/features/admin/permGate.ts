import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { isAdmin, isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { canAdmin, labelPermissions, PERMS } from "./permissions.js";

const MAP = labelPermissions(ADMIN_MENU_LABELS as unknown as Record<string, string>);

/** One central check: a regular admin who taps a button whose permission the owner switched off is stopped here. */
export function registerPermissionGate(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const perm = MAP[ctx.message.text.trim()];
    if (!perm || !isAdmin(ctx) || isOwner(ctx)) return next();
    if (canAdmin(ctx, perm)) return next();
    await ctx.reply(`⛔ دسترسی «${PERMS[perm]}» برای تو فعال نیست. از مالک بخواه فعالش کنه.`);
  });
}
