import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getRecentAdminLogs } from "../../db/models/adminLog.js";
import { describeAdminAction, tehranTime } from "../../services/adminAudit.js";
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

    const blocks: string[] = [];
    for (const l of logs) blocks.push(`${await describeAdminAction(l.adminId, l.action, l.details)}\n🕒 ${tehranTime(l.createdAt)}`);
    // Telegram caps a message at 4096 characters: send in chunks, newest first
    let chunk = "🔐 آخرین فعالیت‌های ادمین‌ها:\n";
    for (const b of blocks) {
      if ((chunk + "\n──────────\n" + b).length > 3800) { await ctx.reply(chunk); chunk = ""; }
      chunk += (chunk ? "\n──────────\n" : "") + b;
    }
    if (chunk) await ctx.reply(chunk);
  });
}
