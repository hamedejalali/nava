import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { syncWalletDeposits, walletStats } from "../../services/wallet/walletDeposits.js";
import { isWalletIntegrationEnabled, setWalletIntegrationEnabled } from "../../services/wallet/walletSettings.js";
import { walletBaseUrl } from "../../services/wallet/walletClient.js";

/** Owner-only panel «🔌 اتصال ولت»: connection state (env ✅/❌), on/off switch, 24h stats, last 10 deposits. No secret is ever shown. */
const TOGGLE = "admin:wallet:toggle";
const SYNC = "admin:wallet:sync";

const tick = (b: unknown) => (b ? "✅" : "❌");

async function view() {
  const enabled = await isWalletIntegrationEnabled();
  const host = (() => {
    try {
      const u = walletBaseUrl();
      return u ? new URL(u).host : null;
    } catch {
      return null;
    }
  })();
  const st = await walletStats();
  const last = st.recent
    .map((r) => `• <code>${String(r._id).slice(0, 14)}</code> · ${r.userId} · ${r.amount} ژتون${r.fee !== undefined ? ` (کارمزد ${r.fee})` : ""} · ${r.creditedAt.toISOString().slice(5, 16).replace("T", " ")}`)
    .join("\n");
  const sy = st.sync;
  const text =
    `🔌 <b>اتصال ولت (دریافت ژتون)</b>\n\n` +
    `${tick(host)} WALLET_API_URL${host ? ` (${host})` : ""}\n` +
    `${tick(env.wallet.integrationId)} WALLET_INTEGRATION_ID\n` +
    `${tick(env.wallet.secret)} WALLET_API_SECRET\n` +
    `واریز از ولت: ${enabled ? "🟢 روشن" : "🔴 خاموش"}\n\n` +
    `📊 ۲۴ ساعت اخیر: ${st.count24h} واریز · مجموع ${st.sum24h} ژتون\n` +
    `آخرین همگام‌سازی موفق: ${sy?.lastOkAt ? sy.lastOkAt.toISOString().slice(0, 16).replace("T", " ") : "—"}` +
    (sy?.lastError ? `\n⚠️ آخرین خطا: ${sy.lastError}` : "") +
    `\n\n<b>آخرین ۱۰ واریز</b>\n${last || "— هنوز واریزی نیست —"}\n\n` +
    `خاموش کردن فقط دریافت از ولت رو می‌بنده؛ بقیه‌ی ربات عادی کار می‌کنه. ژتون فقط وقتی اضافه میشه که خود ولت واریز رو «COMPLETED» اعلام کنه.`;
  return {
    text,
    reply_markup: inlineKeyboard([
      [glassButton(enabled ? "🔴 خاموش کن" : "🟢 روشن کن", TOGGLE, enabled ? "danger" : "success")],
      [glassButton("🔄 همگام‌سازی همین الان", SYNC, "primary")],
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

  composer.callbackQuery(SYNC, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await syncWalletDeposits(ctx.api, { force: true });
    await ctx.answerCallbackQuery({ text: r.error ? `خطا: ${r.error}` : `بررسی شد: ${r.fetched} تراکنش · ${r.credited} واریز جدید`, show_alert: true });
    const v = await view();
    await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup }).catch(() => {});
  });
}
