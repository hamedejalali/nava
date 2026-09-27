import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getBotSettings, setMaintenanceMode } from "../../db/models/settings.js";
import { isAdmin } from "./constants.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

const CB = { toggleMaintenance: "admin:settings:toggle_maintenance" };

async function screen(ctx: NavaContext) {
  const settings = await getBotSettings();
  await ctx.reply(`⚙️ تنظیمات ربات\n\nحالت تعمیر و نگهداری: ${settings.maintenanceMode ? "🟢 فعال" : "🔴 غیرفعال"}`, {
    reply_markup: inlineKeyboard([
      [glassButton(settings.maintenanceMode ? "غیرفعال کردن حالت تعمیر" : "فعال کردن حالت تعمیر", CB.toggleMaintenance, "primary")],
    ]),
  });
}

export function registerAdminSettings(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.settings) return next();
    await screen(ctx);
  });

  composer.callbackQuery(CB.toggleMaintenance, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const current = await getBotSettings();
    await setMaintenanceMode(!current.maintenanceMode);
    await logAdminAction(ctx.from!.id, "toggle_maintenance", String(!current.maintenanceMode));
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await screen(ctx);
  });
}
