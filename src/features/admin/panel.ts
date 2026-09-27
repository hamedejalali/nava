import type { Composer } from "grammy";
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

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.guidesAndChannels) return next();
    await ctx.reply("راهنما، پشتیبانی و کانال‌ها:", { reply_markup: guidesAndChannelsMenu() });
  });
}
