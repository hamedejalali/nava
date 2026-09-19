import { Bot, InlineKeyboard } from "grammy";
import { env } from "./config/env.js";
import { getOrCreateUser } from "./db/models/user.js";
import type { NavaContext } from "./bot-context.js";

/**
 * The Premium Wallet bot is intentionally just this: one command, one
 * button, that opens the Mini App (see /mnt PREMIUM_WALLET folder for its
 * frontend). All real behavior — mining, balance, transfers — happens
 * inside the Mini App talking to api/wallet/*.ts, never through bot
 * commands/buttons here, per the owner's explicit design ("هیچ دکمه ای
 * چیزی نداره").
 */
export function createWalletBot() {
  const token = env.WALLET_BOT_TOKEN;
  if (!token) {
    throw new Error("[walletBot] WALLET_BOT_TOKEN is not set.");
  }

  const bot = new Bot<NavaContext>(token);

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;

    // Same shared `users` collection as the Nava bot — a Relic balance is
    // one single field either bot reads/writes, never a separate number
    // that needs syncing.
    await getOrCreateUser({
      telegramId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
    });

    const miniAppUrl = env.WALLET_MINIAPP_URL;
    if (!miniAppUrl) {
      await ctx.reply("Mini App هنوز پیکربندی نشده. لطفاً WALLET_MINIAPP_URL رو در تنظیمات ست کنید.");
      return;
    }

    const kb = new InlineKeyboard().webApp("👑 باز کردن کیف پول", miniAppUrl);
    await ctx.reply("به ولت پریمیوم نوا خوش اومدی! برای ماین کردن، خرید و انتقال رلیک، کیف پولت رو باز کن:", {
      reply_markup: kb,
    });
  });

  bot.catch((err) => {
    console.error("[walletBot] Unhandled error:", err);
  });

  return bot;
}
