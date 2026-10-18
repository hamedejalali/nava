import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getBotSettings, setMaintenanceAllowIds, setMaintenanceMode } from "../../db/models/settings.js";
import { isAdmin } from "./constants.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { NG_CB } from "./navagramAdmin.js";
import { SEED_CB } from "./seedsAdmin.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";

const CB = {
  toggleMaintenance: "admin:settings:toggle_maintenance",
  allowList: "admin:settings:allow_list",
};

const FLOW = "maint_allow";

async function screen(ctx: NavaContext) {
  const settings = await getBotSettings();
  const allow = settings.maintenanceAllowIds ?? [];
  await ctx.reply(
    `⚙️ تنظیمات ربات\n\n` +
      `ربات: ${settings.maintenanceMode ? "🔴 خاموش (کاربران عادی متن خاموشی را می‌بینند)" : "🟢 روشن"}\n` +
      `آیدی‌های مجاز در زمان خاموشی: ${allow.length}\n\n` +
      `متن خاموشی از «🛠 راهنما / کانال جوین / پشتیبانی ← ویرایش راهنما ها ← متن خاموشی ربات» قابل ویرایش است.`,
    {
      reply_markup: inlineKeyboard([
        [glassButton(settings.maintenanceMode ? "🟢 روشن کردن ربات" : "🔴 خاموش کردن ربات", CB.toggleMaintenance, "primary")],
        [glassButton(`📋 آیدی‌های مجاز در خاموشی (${allow.length})`, CB.allowList, "primary")],
        [glassButton("🎭 ممبرهای پیش‌فرض", SEED_CB.open, "primary")],
        [glassButton("📸 تنظیمات نوا گرام", NG_CB.open, "primary")],
      ]),
    },
  );
}

/** "123 456, 789\n1011" -> [123,456,789,1011]; anything that is not a plain positive integer is reported back. */
export function parseIdList(text: string): { ids: number[]; bad: string[] } {
  const ids: number[] = [];
  const bad: string[] = [];
  for (const tok of text.split(/[\s,،;؛]+/).filter(Boolean)) {
    const latin = tok.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    if (/^\d{1,15}$/.test(latin) && Number(latin) > 0) ids.push(Number(latin));
    else bad.push(tok);
  }
  return { ids: [...new Set(ids)], bad };
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

  composer.callbackQuery(CB.allowList, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const allow = (await getBotSettings()).maintenanceAllowIds ?? [];
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "await_ids" });
    await ctx.reply(
      `📋 آیدی‌های عددی تلگرام که وقتی ربات خاموشه هم کامل کار می‌کنن (برای تست).\n\n` +
        `لیست فعلی: ${allow.length ? allow.join("، ") : "خالی"}\n\n` +
        `لیست جدید رو بفرست (با فاصله، ویرگول یا خط جدا). لیست قبلی با این جایگزین میشه. برای خالی کردن بنویس «خالی».\n` +
        `مالک و ادمین‌ها همیشه دسترسی دارن.`,
      { reply_markup: cancelKeyboard() },
    );
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "await_ids") return next();
    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (text === "خالی") {
      await setMaintenanceAllowIds([]);
      await setAdminFlow(ctx.from!.id, null);
      await logAdminAction(ctx.from!.id, "maintenance_allow_ids", "[]");
      await ctx.reply("✅ لیست خالی شد.");
      return;
    }
    const { ids, bad } = parseIdList(text);
    if (bad.length || ids.length === 0) {
      await ctx.reply(`این موارد آیدی عددی معتبر نیستن: ${bad.length ? bad.slice(0, 5).join("، ") : "(چیزی پیدا نشد)"}\nدوباره بفرست یا لغو کن.`);
      return;
    }
    const saved = await setMaintenanceAllowIds(ids);
    await setAdminFlow(ctx.from!.id, null);
    await logAdminAction(ctx.from!.id, "maintenance_allow_ids", saved.join(","));
    await ctx.reply(`✅ ${saved.length} آیدی ذخیره شد.`);
  });
}
