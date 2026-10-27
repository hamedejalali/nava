import type { Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { ADMIN_CALLBACKS, isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS, buildAdminReplyKeyboard } from "./menu.js";
import { setAdminFlow } from "./flowState.js";

/**
 * «📝 متن‌ها» — every text an admin can edit, in ONE place (v1.27): guides, rules, pinned promo, support id, invite text, maintenance
 * text, and the texts/buttons of the buy menu.
 */
export function textsMenu() {
  return inlineKeyboard([
    [glassButton("📖 متن راهنما", ADMIN_CALLBACKS.editGuideText, "primary"), glassButton("1️⃣ راهنمای شماره یک", ADMIN_CALLBACKS.editGuide1, "primary")],
    [glassButton("📌 پیام پین", ADMIN_CALLBACKS.editPinnedPromo, "primary"), glassButton("⚖️ قوانین", ADMIN_CALLBACKS.editRules, "primary")],
    [glassButton("🛟 آیدی پشتیبانی", ADMIN_CALLBACKS.editSupportId, "primary"), glassButton("🤝 متن دعوت دوستان", ADMIN_CALLBACKS.editInviteMessage, "primary")],
    [glassButton("🛠 متن خاموشی ربات", ADMIN_CALLBACKS.editMaintenanceText, "primary")],
    [glassButton("🛒 متن‌ها و دکمه‌های منوی خرید", "adm:shop:home", "primary")],
  ]);
}

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

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.texts) return next();
    await ctx.reply("📝 کدوم متن رو ویرایش می‌کنی؟", { reply_markup: textsMenu() });
  });
}
