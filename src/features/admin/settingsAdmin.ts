import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getDb } from "../../db/connect.js";
import { getBotSettings, setMaintenanceAllowIds, setMaintenanceMode } from "../../db/models/settings.js";
import { isAdmin } from "./constants.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";

const CB = {
  toggleMaintenance: "admin:settings:toggle_maintenance",
  allowList: "admin:settings:allow_list",
  add: "admin:settings:al_add",
  ask: "admin:settings:al_ask:", // + id → «حذف؟»
  rm: "admin:settings:al_rm:", // + id → removed
};

const FLOW = "maint_allow";

async function screen(ctx: NavaContext) {
  const settings = await getBotSettings();
  const allow = settings.maintenanceAllowIds ?? [];
  await ctx.reply(
    `⚙️ تنظیمات ربات\n\n` +
      `ربات: ${settings.maintenanceMode ? "🔴 خاموش (کاربران عادی متن خاموشی را می‌بینند)" : "🟢 روشن"}\n` +
      `آیدی‌های مجاز در زمان خاموشی: ${allow.length}\n\n` +
      `متن خاموشی از «📝 متن‌ها ← متن خاموشی ربات» قابل ویرایش است.`,
    {
      reply_markup: inlineKeyboard([
        [glassButton(settings.maintenanceMode ? "🟢 روشن کردن ربات" : "🔴 خاموش کردن ربات", CB.toggleMaintenance, "primary")],
        [glassButton(`📋 آیدی‌های مجاز در خاموشی (${allow.length})`, CB.allowList, "primary")],
      ]),
    },
  );
}

const esc = (t: string) => t.replace(/[<>&]/g, "");

/** one glass button per allowed person: «@username · 123» (or the name / just the id when unknown) */
async function allowLabels(ids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!ids.length) return m;
  const users = await (await getDb()).collection<any>("users").find({ _id: { $in: ids } }, { projection: { username: 1, nickname: 1 } }).toArray().catch(() => []);
  for (const u of users) m.set(u._id, u.username ? `@${u.username} · ${u._id}` : u.nickname ? `${String(u.nickname).slice(0, 14)} · ${u._id}` : String(u._id));
  return m;
}

async function allowKeyboard(ids: number[]) {
  const labels = await allowLabels(ids);
  const rows = ids.map((id) => [glassButton(`👤 ${labels.get(id) ?? id}`, CB.ask + id, "primary")]);
  rows.push([glassButton("➕ افزودن", CB.add, "success")]);
  return inlineKeyboard(rows);
}

const allowText = (n: number) => `📋 مجازها در زمان خاموشی (${n})\n\nاین افراد وقتی ربات خاموشه هم کامل کار می‌کنن (برای تست). روی هر نفر بزن تا حذفش کنی.\nمالک و ادمین‌ها همیشه دسترسی دارن.`;

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
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.maintenance) return next();
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
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    const allow = (await getBotSettings()).maintenanceAllowIds ?? [];
    const text = allowText(allow.length);
    const reply_markup = await allowKeyboard(allow);
    await ctx.editMessageText(text, { reply_markup }).catch(() => ctx.reply(text, { reply_markup }));
  });

  composer.callbackQuery(/^admin:settings:al_ask:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match![1]);
    const label = (await allowLabels([id])).get(id) ?? String(id);
    await ctx.editMessageText(`🗑 «${esc(label)}» از لیست مجازها حذف بشه؟`, {
      reply_markup: inlineKeyboard([[glassButton("🗑 حذف", CB.rm + id, "danger"), glassButton("↩️ بازگشت", CB.allowList, "primary")]]),
    }).catch(() => {});
  });

  composer.callbackQuery(/^admin:settings:al_rm:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    const id = Number(ctx.match![1]);
    const left = ((await getBotSettings()).maintenanceAllowIds ?? []).filter((x) => x !== id);
    await setMaintenanceAllowIds(left);
    await logAdminAction(ctx.from!.id, "maintenance_allow_remove", String(id));
    await ctx.answerCallbackQuery({ text: "حذف شد ✅" });
    await ctx.editMessageText(allowText(left.length), { reply_markup: await allowKeyboard(left) }).catch(() => {});
  });

  composer.callbackQuery(CB.add, async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "await_ids" });
    await ctx.reply(
      `➕ آیدی عددی یا یوزرنیم تلگرامِ فرد رو بفرست (می‌تونی چندتا با فاصله یا خط جدا بفرستی).\n` +
        `مثال: 123456789 یا @username\n` +
        `یوزرنیم فقط برای کسایی کار می‌کنه که ربات رو استارت کردن؛ برای بقیه آیدی عددی بده.`,
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
    const ids: number[] = [];
    const bad: string[] = [];
    const users = (await getDb()).collection<any>("users");
    for (const tok of text.split(/[\s,،;؛]+/).filter(Boolean)) {
      if (tok.startsWith("@") || /^[A-Za-z][\w]{3,31}$/.test(tok)) {
        const name = tok.replace(/^@/, "");
        const u = await users.findOne({ username: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }, { projection: { _id: 1 } }).catch(() => null);
        if (u) ids.push(u._id);
        else bad.push(tok);
        continue;
      }
      const r = parseIdList(tok);
      if (r.ids.length) ids.push(...r.ids);
      else bad.push(tok);
    }
    if (bad.length || ids.length === 0) {
      await ctx.reply(`این موارد پیدا/معتبر نبودن: ${bad.length ? bad.slice(0, 5).join("، ") : "(چیزی پیدا نشد)"}\nدوباره بفرست یا لغو کن.`, { reply_markup: cancelKeyboard() });
      return;
    }
    const merged = [...new Set([...((await getBotSettings()).maintenanceAllowIds ?? []), ...ids])];
    const saved = await setMaintenanceAllowIds(merged);
    await setAdminFlow(ctx.from!.id, null);
    await logAdminAction(ctx.from!.id, "maintenance_allow_add", ids.join(","));
    await ctx.reply(allowText(saved.length), { reply_markup: await allowKeyboard(saved) });
  });
}
