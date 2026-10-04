import type { Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { ADMIN_CALLBACKS, isAdmin } from "./constants.js";
import { CHANNEL_ADMIN_CALLBACKS } from "./channels.js";
import { RELIC_ADMIN_CALLBACKS } from "./relic.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

function guidesAndChannelsMenu() {
  return inlineKeyboard([
    [glassButton("ویرایش راهنما ها", ADMIN_CALLBACKS.openGuideMenu, "primary")],
    [glassButton("آیدی پشتیبانی", ADMIN_CALLBACKS.editSupportId, "primary")],
    [glassButton("تنظیم کانال جوین اجباری", CHANNEL_ADMIN_CALLBACKS.open, "primary")],
    [glassButton("مدیریت رلیک کاربر", RELIC_ADMIN_CALLBACKS.open, "primary")],
  ]);
}

export function registerAdminPanel(composer: Composer<NavaContext>) {
  // Legacy text command — kept as an alternate entry point to the exact
  // same guides/support-id/channels/relic screens reachable from the main
  // admin Reply Keyboard's "🛠 راهنما / کانال جوین / پشتیبانی" button
  // below (registerAdminBroadcast etc. already cover broadcast/user
  // management via that keyboard — this never duplicates that).
  composer.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore — never reveal the panel exists
    await ctx.reply("راهنما، پشتیبانی و کانال‌ها:", { reply_markup: guidesAndChannelsMenu() });
  });

  // Monitoring Mini App — staff only, inline web_app button (the only kind that carries signed initData).
  composer.command("monitor", async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore
    const url = env.MONITOR_MINIAPP_URL;
    if (!url) return void (await ctx.reply("آدرس مانیتورینگ تنظیم نشده است (PUBLIC_URL یا MONITOR_MINIAPP_URL)."));
    await ctx.reply("📊 مانیتورینگ نوا:", { reply_markup: { inline_keyboard: [[{ text: "📊 باز کردن مانیتورینگ", web_app: { url } }]] } });
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.guidesAndChannels) return next();
    await ctx.reply("راهنما، پشتیبانی و کانال‌ها:", { reply_markup: guidesAndChannelsMenu() });
  });
}
