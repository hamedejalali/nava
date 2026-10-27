import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { getAllAppVars, getAppVar, setAppVar } from "../../services/appVars.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isOwner } from "./constants.js";

/**
 * «🧩 متغیرها و تصاویر» (v1.27, owner only) — everything that used to be a Vercel environment variable but is not a secret:
 * photos (send a photo), chat ids, thresholds and switches. Reading order lives in src/services/appVars.ts:
 * panel value → legacy env value (copied here the first time it is read).
 */
type Kind = "image" | "chat" | "number" | "bool" | "text";
interface VarDef {
  key: string;
  label: string;
  kind: Kind;
  hint?: string;
}
const GROUPS: Array<{ id: string; title: string; vars: VarDef[] }> = [
  {
    id: "img",
    title: "🖼 تصاویر",
    vars: [
      { key: "DEFAULT_PHOTO_MALE", label: "عکس پیش‌فرض پسر", kind: "image" },
      { key: "DEFAULT_PHOTO_FEMALE", label: "عکس پیش‌فرض دختر", kind: "image" },
      { key: "INVITE_BANNER_PHOTO", label: "بنر دعوت دوستان", kind: "image" },
      { key: "GAME_SHARE_PHOTO", label: "عکس اشتراک بازی (تخته‌نرد)", kind: "image" },
      { key: "VERIFY_PHOTO_1", label: "نمونه‌ی وریفای ۱", kind: "image" },
      { key: "VERIFY_PHOTO_2", label: "نمونه‌ی وریفای ۲", kind: "image" },
      { key: "VERIFY_PHOTO_3", label: "نمونه‌ی وریفای ۳", kind: "image" },
      { key: "VERIFY_PHOTO_4", label: "نمونه‌ی وریفای ۴", kind: "image" },
      { key: "VERIFY_PHOTO_5", label: "نمونه‌ی وریفای ۵", kind: "image" },
      { key: "VERIFY_APPROVED_PHOTO", label: "عکس پیام «تایید شدی»", kind: "image" },
      { key: "VERIFY_REJECTED_PHOTO", label: "عکس پیام «رد شدی»", kind: "image" },
      { key: "VERIFY_REVOKED_PHOTO", label: "عکس پیام «تیک برداشته شد»", kind: "image" },
    ],
  },
  {
    id: "chat",
    title: "📡 کانال‌ها",
    vars: [
      { key: "MODERATION_LOG_CHAT_ID", label: "کانال مدیریت (قدیمی — بهتره از «📡 کانال‌ها» بزنی)", kind: "chat" },
      { key: "BACKUP_CHANNEL_ID", label: "کانال بک‌آپ اکسل", kind: "chat" },
    ],
  },
  {
    id: "set",
    title: "⚙️ تنظیمات",
    vars: [
      { key: "PROFILE_VIEW_REVEAL_COST", label: "قیمت دیدن پروفایل بیننده (ژتون)", kind: "number", hint: "پیش‌فرض ۱۰" },
      { key: "PROFILE_VIEW_NOTIFY_ADMIN_LOOKUPS", label: "اعلان به کاربر وقتی ادمین پروفایلش را می‌بیند", kind: "bool" },
      { key: "SIGHTENGINE_THRESHOLD", label: "حساسیت تشخیص عکس نامناسب (۰ تا ۱)", kind: "number", hint: "پیش‌فرض 0.5 — کلیدهای API در Vercel می‌مانند" },
      { key: "BOT_USERNAME", label: "یوزرنیم ربات (بدون @)", kind: "text", hint: "خالی بذار تا خودکار از تلگرام گرفته شود" },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.vars);
const find = (k: string) => ALL.find((v) => v.key === k);
const P = "adm:vars:";
const FLOW = "appvar";

const mask = (def: VarDef, v?: string) => {
  if (v === undefined || v === "") return "—";
  if (def.kind === "image") return "✅ ثبت شده";
  return `<code>${escapeHtml(v.length > 40 ? v.slice(0, 40) + "…" : v)}</code>`;
};

async function home(ctx: NavaContext, edit = false) {
  const vars = await getAllAppVars();
  const migrated = Object.keys(process.env).filter((k) => ALL.some((d) => d.key === k) && !vars[k]).length;
  const text =
    "🧩 <b>متغیرها و تصاویر</b>\n\nهمه‌ی تنظیمات غیرمحرمانه اینجاست و دیگه لازم نیست داخل Vercel عوض بشه.\n" +
    (migrated > 0 ? `\n⏳ ${migrated} متغیر قدیمی هنوز منتقل نشده؛ با «⬇️ انتقال از env» همین الان منتقل میشن.\n` : "\n✅ هیچ متغیر قدیمی منتقل‌نشده‌ای نمونده.\n") +
    "\nیک گروه رو انتخاب کن:";
  const kb = inlineKeyboard([
    ...GROUPS.map((g) => [glassButton(g.title, `${P}g:${g.id}`, "primary")]),
    [glassButton("⬇️ انتقال همه‌ی متغیرهای env به پنل", `${P}mig`, "success")],
  ]);
  await render(ctx, text, kb, edit);
}

async function render(ctx: NavaContext, text: string, kb: ReturnType<typeof inlineKeyboard>, edit: boolean) {
  const o = { parse_mode: "HTML" as const, reply_markup: kb };
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, o);
      return;
    } catch (e: any) {
      if (/not modified/i.test(String(e?.description ?? e?.message))) return;
    }
  }
  await ctx.reply(text, o);
}

async function group(ctx: NavaContext, id: string, edit = true) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return home(ctx, edit);
  const vars = await getAllAppVars();
  const rows = [];
  let lines = "";
  for (const d of g.vars) {
    const v = vars[d.key] ?? (await getAppVar(d.key));
    lines += `${d.label}: ${mask(d, v)}\n`;
    rows.push([glassButton(`${v ? "✏️" : "➕"} ${d.label}`, `${P}v:${d.key}`, v ? "primary" : "success")]);
  }
  rows.push([glassButton("↩️ بازگشت", `${P}home`, "danger")]);
  await render(ctx, `<b>${g.title}</b>\n\n${lines}`, inlineKeyboard(rows), edit);
}

export function registerVarsAdmin(composer: Composer<NavaContext>) {
  const guard = async (ctx: NavaContext) => {
    if (isOwner(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }).catch(() => {});
    return false;
  };

  composer.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text === ADMIN_MENU_LABELS.vars) {
      if (!isOwner(ctx)) return next();
      await setAdminFlow(ctx.from!.id, null);
      await home(ctx);
      return;
    }
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const def = find(String(flow.data?.key));
    if (!def || def.kind === "image") return void (await ctx.reply("برای این مورد یک «عکس» بفرست.", { reply_markup: cancelKeyboard() }));
    let value = text;
    if (def.kind === "chat") {
      if (!/^-?\d{5,20}$/.test(text)) return void (await ctx.reply("آیدی عددی معتبر نیست؛ مثل -1001234567890 بفرست.", { reply_markup: cancelKeyboard() }));
    } else if (def.kind === "number") {
      const n = Number(text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      if (!Number.isFinite(n) || n < 0) return void (await ctx.reply("یک عدد معتبر بفرست.", { reply_markup: cancelKeyboard() }));
      value = String(n);
    } else if (def.kind === "bool") {
      const yes = ["روشن", "بله", "on", "true", "1"].includes(text.toLowerCase());
      const no = ["خاموش", "خیر", "off", "false", "0"].includes(text.toLowerCase());
      if (!yes && !no) return void (await ctx.reply("«روشن» یا «خاموش» بفرست.", { reply_markup: cancelKeyboard() }));
      value = yes ? "true" : "false";
    } else if (def.key === "BOT_USERNAME") {
      value = text.replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{4,32}$/.test(value)) return void (await ctx.reply("یوزرنیم معتبر نیست.", { reply_markup: cancelKeyboard() }));
    }
    await setAppVar(def.key, value);
    await logAdminAction(ctx.from!.id, "var_set", def.key);
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply(`✅ «${def.label}» ذخیره شد.`);
    await group(ctx, GROUPS.find((g) => g.vars.includes(def))!.id, false);
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    const def = find(String(flow.data?.key));
    if (!def || def.kind !== "image") return void (await ctx.reply("برای این مورد متن بفرست.", { reply_markup: cancelKeyboard() }));
    const largest = ctx.message.photo[ctx.message.photo.length - 1]!;
    await setAppVar(def.key, largest.file_id);
    await logAdminAction(ctx.from!.id, "var_set", def.key);
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply(`✅ «${def.label}» ذخیره شد.`);
    await group(ctx, GROUPS.find((g) => g.vars.includes(def))!.id, false);
  });

  composer.callbackQuery(`${P}home`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await home(ctx, true);
  });

  composer.callbackQuery(/^adm:vars:g:([a-z]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await group(ctx, ctx.match![1]!);
  });

  composer.callbackQuery(/^adm:vars:v:([A-Z0-9_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const def = find(ctx.match![1]!);
    if (!def) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const cur = await getAppVar(def.key);
    if (def.kind === "image" && cur) await ctx.replyWithPhoto(cur, { caption: `تصویر فعلی: ${def.label}` }).catch(() => {});
    const ask =
      def.kind === "image" ? "یک عکس بفرست تا جایگزین بشه." : def.kind === "bool" ? "«روشن» یا «خاموش» بفرست." : def.kind === "number" ? "یک عدد بفرست." : def.kind === "chat" ? "آیدی عددی کانال/چت رو بفرست." : "مقدار جدید رو بفرست.";
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "await", data: { key: def.key } });
    await ctx.reply(`✏️ ${def.label}\n${def.hint ? def.hint + "\n" : ""}${ask}`, {
      reply_markup: cancelKeyboard(),
    });
    if (cur) await ctx.reply("برای حذف مقدار فعلی از دکمه‌ی زیر استفاده کن:", { reply_markup: inlineKeyboard([[glassButton("🗑 حذف این مقدار", `${P}del:${def.key}`, "danger")]]) });
  });

  composer.callbackQuery(/^adm:vars:del:([A-Z0-9_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const def = find(ctx.match![1]!);
    if (!def) return void (await ctx.answerCallbackQuery());
    await setAppVar(def.key, null);
    await logAdminAction(ctx.from!.id, "var_clear", def.key);
    await setAdminFlow(ctx.from!.id, null);
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await ctx.editMessageText("🗑 حذف شد.").catch(() => {});
  });

  composer.callbackQuery(`${P}mig`, async (ctx) => {
    if (!(await guard(ctx))) return;
    let n = 0;
    for (const d of ALL) {
      const before = (await getAllAppVars())[d.key];
      if (before) continue;
      const v = await getAppVar(d.key); // copies the env value into the panel
      if (v) n++;
    }
    await logAdminAction(ctx.from!.id, "vars_migrate", String(n));
    await ctx.answerCallbackQuery({ text: n ? `${n} متغیر منتقل شد ✅` : "چیزی برای انتقال نبود", show_alert: true });
    await home(ctx, true);
  });
}
