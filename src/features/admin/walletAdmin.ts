import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { isWalletIntegrationEnabled, setWalletIntegrationEnabled } from "../../services/wallet/walletAuth.js";

/** Owner-only panel «🔌 اتصال ولت»: shows the state of the Wallet -> Nava XP integration and switches it on/off. No secret is ever shown. */
const TOGGLE = "admin:wallet:toggle";

async function view() {
  const configured = !!(env.wallet.keyId && env.wallet.secret);
  const enabled = await isWalletIntegrationEnabled();
  const db = await getDb();
  const day = new Date(Date.now() - 86_400_000);
  const [tokens, total, recent] = await Promise.all([
    db.collection<any>("xp_transfer_tokens").countDocuments({ status: "active" }),
    db.collection<any>("xp_wallet_transfers").countDocuments({}),
    db.collection<any>("xp_wallet_transfers").countDocuments({ createdAt: { $gte: day } }),
  ]);
  const text =
    `🔌 <b>اتصال ولت (انتقال XP)</b>\n\n` +
    `کلیدها (Vercel): ${configured ? "✅ تنظیم شده" : "❌ تنظیم نشده (WALLET_API_KEY_ID / WALLET_API_SECRET)"}\n` +
    `وضعیت: ${enabled ? "🟢 روشن" : "🔴 خاموش"}\n` +
    `توکن‌های فعال کاربرها: ${tokens}\n` +
    `انتقال‌های ثبت‌شده: ${total} (۲۴ ساعت اخیر: ${recent})\n\n` +
    `خاموش کردنِ اتصال، فقط دریافت XP از ولت رو می‌بنده؛ بقیه‌ی ربات عادی کار می‌کنه.`;
  return { text, reply_markup: inlineKeyboard([[glassButton(enabled ? "🔴 خاموش کن" : "🟢 روشن کن", TOGGLE, enabled ? "danger" : "success")]]) };
}

export function registerAdminWallet(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.wallet) return next();
    if (!isOwner(ctx)) return next();
    const v = await view();
    await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup });
  });

  composer.callbackQuery(TOGGLE, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const now = await isWalletIntegrationEnabled();
    await setWalletIntegrationEnabled(!now, ctx.from!.id);
    await logAdminAction(ctx.from!.id, "wallet_toggle", now ? "off" : "on");
    await ctx.answerCallbackQuery({ text: now ? "خاموش شد" : "روشن شد" });
    const v = await view();
    await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup }).catch(() => {});
  });
}
