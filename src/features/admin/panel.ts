import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { ADMIN_CALLBACKS, isAdmin } from "./constants.js";
import { CHANNEL_ADMIN_CALLBACKS } from "./channels.js";
import { RELIC_ADMIN_CALLBACKS } from "./relic.js";

const SEND_MESSAGE_CB = {
  open: "admin:send",
  broadcast: "admin:send:broadcast",
  toUser: "admin:send:to_user",
};
export { SEND_MESSAGE_CB };

export function registerAdminPanel(composer: Composer<NavaContext>) {
  composer.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore — never reveal the panel exists

    await ctx.reply("پنل ادمین", {
      reply_markup: inlineKeyboard([
        [glassButton("ویرایش راهنما ها", ADMIN_CALLBACKS.openGuideMenu, "primary")],
        [glassButton("آیدی پشتیبانی", ADMIN_CALLBACKS.editSupportId, "primary")],
        [glassButton("تنظیم کانال جوین اجباری", CHANNEL_ADMIN_CALLBACKS.open, "primary")],
        [glassButton("مدیریت رلیک کاربر", RELIC_ADMIN_CALLBACKS.open, "primary")],
        [glassButton("ارسال پیام", SEND_MESSAGE_CB.open, "primary")],
      ]),
    });
  });

  // "ارسال پیام" submenu — navigation only per spec's staged approach.
  // Broadcast delivery (batching, retries, blocked-user handling, forward
  // preservation) and single-user targeting are a substantial subsystem of
  // their own and are intentionally NOT implemented in this pass; taps on
  // these two buttons are safely acknowledged by the bot's generic
  // callback fallback (src/bot.ts) until that subsystem is built.
  composer.callbackQuery(SEND_MESSAGE_CB.open, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("پیام رو برای کی بفرستم؟", {
      reply_markup: inlineKeyboard([
        [glassButton("پیام همگانی", SEND_MESSAGE_CB.broadcast, "primary")],
        [glassButton("پیام به یک کاربر", SEND_MESSAGE_CB.toUser, "primary")],
      ]),
    });
  });
}
