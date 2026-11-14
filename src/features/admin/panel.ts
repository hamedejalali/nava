import type { Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { isAdmin } from "./constants.js";
import { buildAdminReplyKeyboard } from "./menu.js";
import { setAdminFlow } from "./flowState.js";

export function registerAdminPanel(composer: Composer<NavaContext>) {
  // Alternate entry point: /admin opens the main panel keyboard (the same one «/start» shows to an admin).
  composer.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore — never reveal the panel exists
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply("پنل مدیریت 👇", { reply_markup: buildAdminReplyKeyboard(ctx) });
  });

  // Monitoring Mini App — staff only, inline web_app button (the only kind that carries signed initData).
  composer.command("monitor", async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore
    const url = env.MONITOR_MINIAPP_URL;
    if (!url) return void (await ctx.reply("آدرس مانیتورینگ تنظیم نشده است (PUBLIC_URL یا MONITOR_MINIAPP_URL)."));
    await ctx.reply("📊 مانیتورینگ مویا:", { reply_markup: { inline_keyboard: [[{ text: "📊 باز کردن مانیتورینگ", web_app: { url } }]] } });
  });

}
