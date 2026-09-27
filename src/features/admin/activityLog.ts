import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getRecentAdminLogs } from "../../db/models/adminLog.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

export function registerAdminActivityLog(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.activityLog) return next();

    const logs = await getRecentAdminLogs(20);
    if (logs.length === 0) {
      await ctx.reply("هنوز هیچ فعالیتی ثبت نشده.");
      return;
    }

    const lines = logs.map((l) => `• ${l.createdAt.toISOString()} — ادمین ${l.adminId} — ${l.action}${l.details ? ` (${l.details})` : ""}`);
    await ctx.reply(`🔐 آخرین فعالیت‌های ادمین‌ها:\n\n${lines.join("\n")}`);
  });
}
