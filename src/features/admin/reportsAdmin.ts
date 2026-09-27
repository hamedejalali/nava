import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { listOpenReports, markReportReviewed } from "../../db/models/reports.js";
import { isAdmin } from "./constants.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

export function registerAdminReports(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.reports) return next();

    const reports = await listOpenReports(10);
    if (reports.length === 0) {
      await ctx.reply("هیچ گزارش بازبینی‌نشده‌ای نیست. ✅");
      return;
    }

    for (const r of reports) {
      await ctx.reply(
        `⚠️ گزارش\n\nگزارش‌دهنده: ${r.reporterId}\nگزارش‌شده: ${r.reportedId}\nتاریخ: ${r.createdAt.toISOString()}`,
        { reply_markup: inlineKeyboard([[glassButton("✅ بررسی شد", `admin:report:review:${r._id}`, "success")]]) }
      );
    }
  });

  composer.callbackQuery(/^admin:report:review:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await markReportReviewed(ctx.match![1]!, ctx.from!.id);
    await logAdminAction(ctx.from!.id, "review_report", ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "ثبت شد." });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  });
}
