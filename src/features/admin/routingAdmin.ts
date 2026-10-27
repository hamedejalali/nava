import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { getBotSettings, patchBotSettings } from "../../db/models/settings.js";
import { getMiniSettings } from "../../services/nava/settings.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ROUTE_PURPOSES, isRoutePurpose, routeOf, type RouteDest } from "../../services/channelRouting.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isOwner, isAdmin } from "./constants.js";
import { CHANNEL_ADMIN_CALLBACKS } from "./channels.js";
import { NG_CB } from "./navagramAdmin.js";
import { getAppVar, setAppVar } from "../../services/appVars.js";

/** «📡 کانال‌ها و مسیر پیام‌ها» — one screen: the management channel + where every kind of staff message goes. */
const P = "adm:route:";
const FLOW = "route";
const DEST_LABEL: Record<RouteDest, string> = { mgmt: "📡 کانال مدیریت", dm: "👤 چت مالک", off: "⛔ خاموش" };
const NEXT: Record<RouteDest, RouteDest> = { mgmt: "dm", dm: "off", off: "mgmt" };

async function view() {
  const s = await getBotSettings();
  const mini = await getMiniSettings().catch(() => ({} as any));
  const mgmt = s.managementChannelId ?? (await getAppVar("MODERATION_LOG_CHAT_ID").then((x) => (x ? Number(x) : undefined)));
  const backup = await getAppVar("BACKUP_CHANNEL_ID");
  const rows = [];
  let lines = "";
  for (const k of Object.keys(ROUTE_PURPOSES) as Array<keyof typeof ROUTE_PURPOSES>) {
    const d = await routeOf(k);
    lines += `${ROUTE_PURPOSES[k]} ← ${DEST_LABEL[d]}\n`;
    rows.push([glassButton(`${ROUTE_PURPOSES[k]} · ${DEST_LABEL[d]}`, `${P}t:${k}`, d === "mgmt" ? "success" : d === "dm" ? "primary" : "danger")]);
  }
  const text =
    "📡 <b>کانال‌ها</b> — همه‌ی کانال‌های ربات از همین‌جا تنظیم میشن\n\n" +
    `<b>کانال مدیریت:</b> ${mgmt !== undefined ? `<code>${mgmt}</code>${s.managementChannelTitle ? " — " + escapeHtml(s.managementChannelTitle) : ""}${s.managementChannelId === undefined ? " (از متغیر قدیمی MODERATION_LOG_CHAT_ID)" : ""}` : "تنظیم نشده (پیام‌ها به چت مالک میرن)"}\n` +
    `<b>کانال اصلی (کپی پست‌ها):</b> ${mini.postsChannelId ? `<code>${mini.postsChannelId}</code>` : "تنظیم نشده"} — پست‌های مویاگرام\n` +
    `<b>کانال بک‌آپ (خروجی اکسل):</b> ${backup ? `<code>${backup}</code>` : "تنظیم نشده"}\n` +
    `<b>کانال حراج و قرعه‌کشی:</b> ${mini.eventsChannelId ? `<code>${mini.eventsChannelId}</code>` : "تنظیم نشده"}\n` +
    "\n" +
    "هر نوع پیام رو بزن تا بین «کانال مدیریت ← چت مالک ← خاموش» عوض بشه:\n\n" + lines;
  return {
    text,
    kb: inlineKeyboard([
      [glassButton("📢 کانال‌های جوین اجباری", CHANNEL_ADMIN_CALLBACKS.open, "primary")],
      [glassButton("📸 کانال پست‌ها و حراج (مویاگرام)", NG_CB.open, "primary")],
      [glassButton("📡 تنظیم کانال مدیریت", `${P}set`, "primary"), glassButton("🧹 حذف", `${P}clr`, "danger")],
      [glassButton("💾 تنظیم کانال بک‌آپ", `${P}bk`, "primary"), glassButton("🧹 حذف", `${P}bkc`, "danger")],
      ...rows,
    ]),
  };
}

async function show(ctx: NavaContext, edit: boolean) {
  const v = await view();
  const o = { parse_mode: "HTML" as const, reply_markup: v.kb };
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(v.text, o);
      return;
    } catch (err: any) {
      if (/not modified/i.test(String(err?.description ?? err?.message))) return;
    }
  }
  await ctx.reply(v.text, o);
}

export function registerRoutingAdmin(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text === ADMIN_MENU_LABELS.channels && isAdmin(ctx) && !isOwner(ctx)) {
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("📡 کانال‌ها", { reply_markup: inlineKeyboard([[glassButton("📢 کانال‌های جوین اجباری", CHANNEL_ADMIN_CALLBACKS.open, "primary")]]) });
      return;
    }
    if (!isOwner(ctx)) return next();
    if (text === ADMIN_MENU_LABELS.channels) {
      await setAdminFlow(ctx.from!.id, null);
      await show(ctx, false);
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (flow.stage === "backup") {
      const bref = /^-?\d{5,20}$/.test(text) ? text : /^@[A-Za-z0-9_]{4,}$/.test(text) ? text : null;
      if (!bref) return void (await ctx.reply("آیدی معتبر نیست. مثل -1001234567890 یا @mychannel بفرست.", { reply_markup: cancelKeyboard() }));
      try {
        const chat = await ctx.api.getChat(bref);
        const me = await ctx.api.getChatMember(chat.id, ctx.me.id);
        if (me.status !== "administrator" && me.status !== "creator") throw new Error("not admin");
        await setAppVar("BACKUP_CHANNEL_ID", String(chat.id));
        await logAdminAction(ctx.from!.id, "backup_channel_set", String(chat.id));
        await setAdminFlow(ctx.from!.id, null);
        await ctx.reply("✅ کانال بک‌آپ ذخیره شد.");
        await show(ctx, false);
      } catch {
        await ctx.reply("نتونستم به این کانال دسترسی پیدا کنم. ربات باید داخلش ادمین باشه؛ بعد دوباره بفرست.", { reply_markup: cancelKeyboard() });
      }
      return;
    }
    const ref = /^-?\d{5,20}$/.test(text) ? text : /^@[A-Za-z0-9_]{4,}$/.test(text) ? text : null;
    if (!ref) return void (await ctx.reply("آیدی معتبر نیست. مثل -1001234567890 یا @mychannel بفرست.", { reply_markup: cancelKeyboard() }));
    try {
      const chat = await ctx.api.getChat(ref);
      const me = await ctx.api.getChatMember(chat.id, ctx.me.id);
      if (me.status !== "administrator" && me.status !== "creator") throw new Error("not admin");
      const mini = await getMiniSettings().catch(() => ({} as any));
      if (chat.id === mini.postsChannelId || chat.id === mini.eventsChannelId) {
        return void (await ctx.reply("این کانال همون کانال اصلی/حراجه. برای مدیریت یه کانال جدا بفرست.", { reply_markup: cancelKeyboard() }));
      }
      await patchBotSettings({ managementChannelId: chat.id, managementChannelTitle: "title" in chat ? (chat.title ?? "") : "" });
      await logAdminAction(ctx.from!.id, "mgmt_channel_set", String(chat.id));
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("✅ کانال مدیریت ذخیره شد.");
      await show(ctx, false);
    } catch {
      await ctx.reply("نتونستم به این کانال دسترسی پیدا کنم. ربات باید داخلش ادمین باشه؛ بعد دوباره بفرست.", { reply_markup: cancelKeyboard() });
    }
  });

  const guard = async (ctx: NavaContext) => {
    if (isOwner(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }).catch(() => {});
    return false;
  };

  composer.callbackQuery(`${P}set`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "channel" });
    await ctx.reply("آیدی عددی کانال مدیریت (مثل -1001234567890) یا @یوزرنیمش رو بفرست. ربات باید داخلش ادمین باشه.", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(`${P}bk`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "backup" });
    await ctx.reply("آیدی عددی کانال بک‌آپ (مثل -1001234567890) یا @یوزرنیمش رو بفرست. ربات باید داخلش ادمین باشه.", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(`${P}bkc`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await setAppVar("BACKUP_CHANNEL_ID", null);
    await logAdminAction(ctx.from!.id, "backup_channel_clear");
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await show(ctx, true);
  });

  composer.callbackQuery(`${P}clr`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await patchBotSettings({ managementChannelId: undefined as any, managementChannelTitle: undefined as any });
    await logAdminAction(ctx.from!.id, "mgmt_channel_clear");
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await show(ctx, true);
  });

  composer.callbackQuery(/^adm:route:t:([A-Za-z]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const k = ctx.match![1]!;
    if (!isRoutePurpose(k)) return void (await ctx.answerCallbackQuery());
    const s = await getBotSettings();
    const next = NEXT[await routeOf(k)];
    await patchBotSettings({ routes: { ...(s.routes ?? {}), [k]: next } });
    await logAdminAction(ctx.from!.id, "route_set", `${k}:${next}`);
    await ctx.answerCallbackQuery({ text: DEST_LABEL[next] });
    await show(ctx, true);
  });
}
