import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { sweepPendingDeposits } from "../../services/wallet/walletDeposits.js";
import { isWalletIntegrationEnabled, setWalletIntegrationEnabled } from "../../services/wallet/walletSettings.js";

/** Owner-only panel «🔌 اتصال ولت»: shows the state of the Wallet -> Nava XP integration and switches it on/off. No secret is ever shown. */
const TOGGLE = "admin:wallet:toggle";
const SWEEP = "admin:wallet:sweep";

async function view() {
  const enabled = await isWalletIntegrationEnabled();
  const host = (() => {
    try {
      return env.wallet.url ? new URL(env.wallet.url).host : null;
    } catch {
      return null;
    }
  })();
  const db = await getDb();
  const dep = db.collection<any>("wallet_deposits");
  const day = new Date(Date.now() - 86_400_000);
  const [pending, done, failed, recent] = await Promise.all([
    dep.countDocuments({ status: { $in: ["creating", "pending"] } }),
    dep.countDocuments({ status: "completed" }),
    dep.countDocuments({ status: "failed" }),
    dep.countDocuments({ createdAt: { $gte: day } }),
  ]);
  const text =
    `🔌 <b>اتصال ولت (واریز XP)</b>\n\n` +
    `آدرس ولت (Vercel): ${host ? "✅ " + host : "❌ WALLET_API_URL"}\n` +
    `شناسه اتصال: ${env.wallet.integrationId ? "✅" : "❌ WALLET_INTEGRATION_ID"}\n` +
    `کلید مخفی: ${env.wallet.secret ? "✅ تنظیم شده" : "❌ WALLET_API_SECRET"}\n` +
    `وضعیت: ${enabled ? "🟢 روشن" : "🔴 خاموش"}\n\n` +
    `واریزها: در انتظار ${pending} · موفق ${done} · ناموفق ${failed} (۲۴ ساعت اخیر: ${recent})\n\n` +
    `خاموش کردن فقط «واریز XP از ولت» رو می‌بنده؛ بقیه‌ی ربات عادی کار می‌کنه.`;
  return {
    text,
    reply_markup: inlineKeyboard([
      [glassButton(enabled ? "🔴 خاموش کن" : "🟢 روشن کن", TOGGLE, enabled ? "danger" : "success")],
      [glassButton("🔄 بررسی انتظارها", SWEEP, "primary")],
    ]),
  };
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
  composer.callbackQuery(SWEEP, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await sweepPendingDeposits(ctx.api);
    await ctx.answerCallbackQuery({ text: `بررسی شد: ${r.checked} · واریز ${r.credited} · ناموفق ${r.failed}`, show_alert: true });
    const v = await view();
    await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup }).catch(() => {});
  });
}
