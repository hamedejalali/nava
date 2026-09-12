import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getUserStats } from "../../db/models/user.js";
import { countOpenReports } from "../../db/models/reports.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

export function registerAdminStats(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.stats) return next();

    const [stats, openReports] = await Promise.all([getUserStats(), countOpenReports()]);

    await ctx.reply(
      [
        `📊 آمار ربات`,
        ``,
        `کل کاربران: ${stats.totalUsers}`,
        `onboarding تکمیل‌شده: ${stats.completedOnboarding}`,
        `کاربران بن‌شده: ${stats.bannedUsers}`,
        `چت‌های فعال هم‌اکنون: ${stats.activeChatsNow}`,
        `گزارش‌های بازبینی‌نشده: ${openReports}`,
      ].join("\n")
    );
  });
}
