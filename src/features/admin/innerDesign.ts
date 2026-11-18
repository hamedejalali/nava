import type { Bot, Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, glassReplyButton, inlineKeyboard, replyKeyboard, type GlassStyle } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { escapeHtml } from "../../utils/html.js";
import { env } from "../../config/env.js";
import { isOwner } from "./constants.js";
import { ADMIN_CATEGORY_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { clearContent, getContentRaw, setContent, type ContentKey } from "../../db/models/content.js";
import { DEFAULT_RULES } from "./guides.js";
import { IMAGE_VARS } from "./varsAdmin.js";
import { getAppVar, setAppVar } from "../../services/appVars.js";
import { setPremiumEnabled } from "../../db/models/emojiConfig.js";
import { premiumEnabled } from "../../config/emojis.js";
import { CATALOG, type CatalogEntry } from "../../generated/textCatalog.js";
import { CATALOG_BY_ID, MAX_CUSTOM_BUTTONS, addCustomButton, customButtons, getDoc, loadOverrides, resetDoc, saveDoc, type BtnStyle } from "../../db/models/uiOverrides.js";
import { emojiSyntaxToHtml, entitiesToSyntax, getOwnerPremium, premiumUsable, renderButtonLabel } from "../../services/emojiSyntax.js";
import { DEFAULT_PROFILE_TEMPLATE, PROFILE_TEMPLATE_ID, PROFILE_VARS, PROFILE_VAR_HELP, SAMPLE_PROFILE_VALUES, renderTemplate, unknownVars } from "../../services/profileTemplate.js";

/**
 * «🎨 طراحی داخلی ربات» (owner only) — four buttons:
 *   🎛 طراحی دکمه‌های ربات · ✨ ایموجی پریمیوم‌ها (on/off) · 🖼 ویرایش عکس‌ها · ✏️ ویرایش متن‌ها
 * Texts / buttons are organised in categories. A category screen has «🚪 ورود به پنل» which opens the list INLINE (the owner's
 * input box gets «@bot t:<n> »); tapping an item sends a tiny marker message that the bot deletes, and the SAME screen becomes the
 * editor. Every input shows the red «لغو»; every text is previewed and confirmed; the screen is edited, not re-sent.
 */
export const DESIGN_LABELS = { buttons: "🎛 طراحی دکمه‌های ربات", emoji: "✨ ایموجی پریمیوم‌ها", photos: "🖼 ویرایش عکس‌ها", texts: "✏️ ویرایش متن‌ها", hub: "🎨 طراحی داخلی ربات" } as const;
const FLOW = "ui";
const PER_PAGE = 8;
const MAX_TEXT = 3500;
const MAX_LABEL = 40;
const STYLE_FA: Record<BtnStyle, string> = { primary: "🟦 آبی", success: "🟩 سبز", danger: "🟥 قرمز", default: "⬜ پیش‌فرض" };
const SYNTAX_HELP = "\n\n💡 ایموجی: یک ایموجی ساده + پریمیوم کنار هم بفرست (مثل ♥️🔥)؛ با پریمیوم روشن و مالکِ پریمیوم‌دار پریمیوم دیده می‌شود، وگرنه ساده. برای رفتن به خط بعد <code>//</code> بزن.";
const NOOV = { no_ui_override: true } as any;
type Markup = ReturnType<typeof inlineKeyboard>;

/* ------------------------------------------------------------------ items (what can be edited) */
interface Item {
  id: string;
  kind: "text" | "button";
  cat: string;
  title: string;
  /** shown as "current" and used as the default of the editor */
  current: () => string;
  vars: string[];
  special?: "content" | "profile" | "custom";
}
const display = (e: CatalogEntry) => e.parts.map((p, i) => p + (e.vars[i] ? `{${e.vars[i]}}` : "")).join("");
const snippet = (t: string, n = 48) => t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

const CONTENT_ITEMS: Array<[ContentKey, string, () => string]> = [
  ["guideText", "متن راهنما", () => "به مویا خوش اومدی! هر سوالی داشتی از همینجا یا با ادمین در میون بذار."],
  ["guide1", "راهنمای شماره یک", () => ""],
  ["pinnedPromo", "پیام پین", () => ""],
  ["rules", "قوانین", () => DEFAULT_RULES],
  ["supportId", "آیدی پشتیبانی", () => ""],
  ["inviteMessage", "متن دعوت دوستان", () => ""],
  ["maintenanceText", "متن خاموشی ربات", () => ""],
];
export const MAIN_CAT = "⭐ متن‌های اصلی و کارت پروفایل";
export const CUSTOM_CAT = "🆕 دکمه‌های ساخته‌شده";

function buildItems(): Item[] {
  const out: Item[] = [];
  for (const [key, title, def] of CONTENT_ITEMS) out.push({ id: `k:${key}`, kind: "text", cat: MAIN_CAT, title, current: def, vars: [], special: "content" });
  out.push({ id: PROFILE_TEMPLATE_ID, kind: "text", cat: MAIN_CAT, title: "🪪 کارت پروفایل (قالب با متغیر)", current: () => DEFAULT_PROFILE_TEMPLATE, vars: [...PROFILE_VARS], special: "profile" });
  for (const e of CATALOG) out.push({ id: e.id, kind: e.kind, cat: e.cat, title: snippet(display(e), 40), current: () => display(e), vars: e.vars });
  return out;
}
const ITEMS = buildItems();
const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
const catsOf = (kind: "text" | "button"): string[] => {
  const cats = [...new Set(ITEMS.filter((i) => i.kind === kind).map((i) => i.cat))];
  return kind === "text" ? [MAIN_CAT, ...cats.filter((c) => c !== MAIN_CAT)] : cats;
};
const KIND_CATS = { text: catsOf("text"), button: catsOf("button") };
const KIND_CODE = { t: "text", b: "button" } as const;

/** current raw value of an item (owner override → shipped) */
async function currentRaw(it: Item): Promise<{ raw: string; edited: boolean }> {
  if (it.special === "content") {
    const v = await getContentRaw(it.id.slice(2) as ContentKey);
    return { raw: v ?? it.current(), edited: v !== undefined };
  }
  const d = getDoc(it.id);
  if (it.special === "profile") return { raw: d?.text ?? DEFAULT_PROFILE_TEMPLATE, edited: d?.text !== undefined };
  return { raw: d?.text ?? it.current(), edited: d?.text !== undefined };
}

/* ------------------------------------------------------------------ hub */
export function buildDesignHubKeyboard() {
  return replyKeyboard([
    [glassReplyButton(DESIGN_LABELS.buttons, "primary"), glassReplyButton(DESIGN_LABELS.emoji, "success")],
    [glassReplyButton(DESIGN_LABELS.photos, "primary"), glassReplyButton(DESIGN_LABELS.texts, "primary")],
    [glassReplyButton(ADMIN_CATEGORY_LABELS.back, "danger")],
  ]);
}

async function show(ctx: NavaContext, text: string, kb: Markup, msg?: number): Promise<number | undefined> {
  const o = { parse_mode: "HTML" as const, reply_markup: kb, ...NOOV };
  try {
    if (msg !== undefined && ctx.chat) {
      await ctx.api.editMessageText(ctx.chat.id, msg, text, o);
      return msg;
    }
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, o);
      return ctx.callbackQuery.message.message_id;
    }
  } catch (err: any) {
    if (/not modified/i.test(String(err?.description ?? err?.message))) return msg ?? ctx.callbackQuery?.message?.message_id;
  }
  return (await ctx.reply(text, o)).message_id;
}

const pageRows = (items: Array<{ label: string; cb: string; style: GlassStyle }>, page: number, prefix: string) => {
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE);
  const rows: any[][] = [];
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2).map((x) => glassButton(x.label.slice(0, 30), x.cb, x.style)));
  const nav: any[] = [];
  if (pg > 0) nav.push(glassButton("◀️ صفحه قبلی", `${prefix}${pg - 1}`, "primary"));
  if (pg < pages - 1) nav.push(glassButton("صفحه بعدی ▶️", `${prefix}${pg + 1}`, "primary"));
  if (nav.length) rows.push(nav);
  return { rows, pg, pages };
};

/* ------------------------------------------------------------------ screens */
async function categories(ctx: NavaContext, kind: "text" | "button", page: number, msg?: number) {
  const code = kind === "text" ? "t" : "b";
  const items = KIND_CATS[kind].map((c, i) => ({ label: c, cb: `ui:c:${code}:${i}`, style: "primary" as GlassStyle }));
  if (kind === "button") items.push({ label: `${CUSTOM_CAT} (${customButtons().length})`, cb: "ui:cu", style: "success" });
  const { rows, pg, pages } = pageRows(items, page, `ui:l:${code}:`);
  if (kind === "button") rows.push([glassButton("➕ دکمه‌ی جدید", "ui:bnew", "success")]);
  return show(
    ctx,
    kind === "text" ? `✏️ <b>ویرایش متن‌ها</b> (صفحه ${pg + 1} از ${pages})\n\nهر پیامی که کاربر می‌بیند در یکی از این دسته‌هاست:` : `🎛 <b>طراحی دکمه‌های ربات</b> (صفحه ${pg + 1} از ${pages})\n\nدکمه‌هایی که کاربر می‌بیند، دسته‌بندی‌شده:`,
    inlineKeyboard(rows),
    msg,
  );
}

async function categoryScreen(ctx: NavaContext, kind: "text" | "button", idx: number, msg?: number) {
  const code = kind === "text" ? "t" : "b";
  const cat = KIND_CATS[kind][idx];
  if (!cat) return categories(ctx, kind, 0, msg);
  const n = ITEMS.filter((i) => i.kind === kind && i.cat === cat).length;
  const id = await show(
    ctx,
    `📂 <b>${escapeHtml(cat)}</b>\n${n} مورد\n\nروی «ورود به پنل» بزن؛ لیست اینلاین باز می‌شود (می‌توانی بعدش کلمه‌ای هم برای جستجو بنویسی). روی هر مورد بزنی، همین‌جا برای ویرایش باز می‌شود.`,
    {
      inline_keyboard: [
        [{ text: "🚪 ورود به پنل", switch_inline_query_current_chat: `${code}:${idx} `, style: "success" } as any],
        [glassButton("↩️ بازگشت", `ui:l:${code}:0`, "danger")],
      ],
    } as any,
    msg,
  );
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "browse", data: { kind, cat: idx, msg: id } as any });
}

async function itemScreen(ctx: NavaContext, it: Item, msg?: number) {
  const { raw, edited } = await currentRaw(it);
  const kindIdx = KIND_CATS[it.kind].indexOf(it.cat);
  const code = it.kind === "text" ? "t" : "b";
  const back = it.special === "custom" ? "ui:cu" : `ui:c:${code}:${kindIdx}`;
  const shown = raw.length > 1500 ? raw.slice(0, 1500) + "…" : raw;
  const vars = it.vars.length
    ? `\n\n<b>متغیرها</b> (دست نزن، فقط متن اطرافشان را عوض کن):\n${it.special === "profile" ? PROFILE_VARS.map((v) => `<code>{${v}}</code> ${PROFILE_VAR_HELP[v]}`).join("\n") : it.vars.map((v) => `<code>{${v}}</code>`).join(" ")}`
    : "";
  if (it.kind === "text") {
    const f = await begin(ctx, "text_await", { id: it.id }, "✍️ متن جدید را بفرست (یا «لغو»)");
    return show(
      ctx,
      `✍️ <b>${escapeHtml(it.cat)}</b>\n\n<b>متن فعلی</b>${edited ? " (ویرایش‌شده)" : ""}:\n<pre>${escapeHtml(shown || "(خالی)")}</pre>${vars}${SYNTAX_HELP}\n\nمتن جدید را بفرست 👇`,
      inlineKeyboard([[glassButton("♻️ بازنشانی", `ui:r:${it.id}`, "danger"), glassButton("↩️ بازگشت", back, "primary")]]),
      msg ?? f,
    );
  }
  // a button
  const d = getDoc(it.id);
  return show(
    ctx,
    `🎛 <b>${escapeHtml(snippet(raw, 60))}</b>\n\nنام فعلی: ${escapeHtml(raw)}${edited ? " (ویرایش‌شده)" : ""}\nرنگ: ${d?.style ? STYLE_FA[d.style] : "همان پیش‌فرض ربات"}\nوضعیت: ${d?.hidden ? "🚫 مخفی" : "✅ نمایش داده می‌شود"}${vars}`,
    inlineKeyboard([
      [glassButton("✏️ تغییر نام", `ui:bn:${it.id}`, "primary"), glassButton("🎨 تغییر رنگ", `ui:bc:${it.id}`, "primary")],
      [glassButton(d?.hidden ? "👁 نمایش بده" : "🚫 مخفی کن", `ui:bh:${it.id}`, "success"), glassButton("♻️ بازنشانی", `ui:r:${it.id}`, "danger")],
      [glassButton("↩️ بازگشت", back, "danger")],
    ]),
    msg,
  );
}

async function customList(ctx: NavaContext, msg?: number) {
  const list = customButtons();
  const rows: any[][] = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((c) => glassButton(renderButtonLabel(c.label ?? "—", { premium: false }).text.slice(0, 30), `ui:ce:${c._id.slice(2)}`, "primary")));
  rows.push([glassButton("➕ دکمه‌ی جدید", "ui:bnew", "success")], [glassButton("↩️ بازگشت", "ui:l:b:0", "danger")]);
  return show(ctx, `${CUSTOM_CAT}\n\nدکمه‌هایی که خودت ساخته‌ای (${list.length} از ${MAX_CUSTOM_BUTTONS}):`, inlineKeyboard(rows), msg);
}

async function customScreen(ctx: NavaContext, n: string, msg?: number) {
  const c = getDoc(`c:${n}`);
  if (!c) return customList(ctx, msg);
  return show(
    ctx,
    `🆕 <b>${escapeHtml(renderButtonLabel(c.label ?? "—", { premium: false }).text)}</b>\n\nرنگ: ${STYLE_FA[c.style ?? "primary"]}\n\n<b>پیامی که بعد از زدن ارسال می‌شود:</b>\n${emojiSyntaxToHtml((c.reply ?? "").slice(0, 1500))}`,
    inlineKeyboard([
      [glassButton("✏️ تغییر نام", `ui:bn:c:${n}`, "primary"), glassButton("🎨 تغییر رنگ", `ui:bc:c:${n}`, "primary")],
      [glassButton("💬 تغییر پیام", `ui:bp:${n}`, "success"), glassButton("🗑 حذف", `ui:bd:${n}`, "danger")],
      [glassButton("↩️ بازگشت", "ui:cu", "danger")],
    ]),
    msg,
  );
}

async function photosList(ctx: NavaContext, page: number, msg?: number) {
  const items: Array<{ label: string; cb: string; style: GlassStyle }> = [];
  for (const v of IMAGE_VARS) {
    const has = !!(await getAppVar(v.key));
    items.push({ label: `${has ? "✅" : "➕"} ${v.label}`, cb: `ui:pe:${v.key}`, style: has ? "primary" : "success" });
  }
  const { rows, pg, pages } = pageRows(items, page, "ui:p:");
  return show(ctx, `🖼 <b>عکس‌های ربات</b> (صفحه ${pg + 1} از ${pages})\n\nروی هر عکس بزن تا برایت فرستاده شود و بتوانی عوضش کنی. ✅ = ثبت شده، ➕ = هنوز ندارد.`, inlineKeyboard(rows), msg);
}

/* ------------------------------------------------------------------ input flows */
interface Pending {
  id?: string;
  n?: string;
  label?: string;
  value?: string;
  fileId?: string;
  key?: string;
  msg?: number;
  prompt?: number;
  kind?: "text" | "button";
  cat?: number;
}

async function begin(ctx: NavaContext, stage: string, p: Pending, ask: string): Promise<number | undefined> {
  const prev = await getAdminFlow(ctx.from!.id);
  const base = prev?.flow === FLOW ? (prev.data as unknown as Pending) : {};
  if (base.prompt) await ctx.api.deleteMessage(ctx.chat!.id, base.prompt).catch(() => {});
  const prompt = await ctx.reply(ask, { reply_markup: cancelKeyboard(), ...NOOV });
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage, data: { ...base, ...p, msg: p.msg ?? base.msg ?? ctx.callbackQuery?.message?.message_id, prompt: prompt.message_id } as any });
  return p.msg ?? base.msg ?? ctx.callbackQuery?.message?.message_id;
}

async function endFlow(ctx: NavaContext, p?: Pending, extraDelete: number[] = []) {
  for (const id of [p?.prompt, ...extraDelete]) if (id) await ctx.api.deleteMessage(ctx.chat!.id, id).catch(() => {});
}

const confirmKb = () => inlineKeyboard([[glassButton("✅ تأیید و ذخیره", "ui:ok", "success"), glassButton("❌ لغو", "ui:no", "danger")]]);

/** back to the category screen the owner came from (so the next item is one tap away) */
async function backToCategory(ctx: NavaContext, p: Pending) {
  const kind = p.kind ?? "text";
  await setAdminFlow(ctx.from!.id, null);
  await categoryScreen(ctx, kind, p.cat ?? 0, p.msg);
}

/** the owner's inline panel: «@bot t:<category> words» */
export function registerOwnerInline(bot: Bot<NavaContext>) {
  bot.on("inline_query", async (ctx, next) => {
    const q = ctx.inlineQuery.query ?? "";
    const m = /^([tb]):(\d+)\s*(.*)$/s.exec(q);
    if (!m) return next();
    if (env.OWNER_ID === undefined || ctx.from.id !== env.OWNER_ID) return void (await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true }).catch(() => {}));
    const kind = KIND_CODE[m[1] as "t" | "b"];
    const cat = KIND_CATS[kind][Number(m[2])];
    const words = m[3]!.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = ITEMS.filter((i) => i.kind === kind && i.cat === cat).filter((i) => words.every((w) => `${i.title} ${i.current()}`.toLowerCase().includes(w)));
    const offset = Number(ctx.inlineQuery.offset || 0);
    const page = all.slice(offset, offset + 40);
    await ctx.answerInlineQuery(
      page.map((it) => ({
        type: "article" as const,
        id: it.id.slice(0, 64),
        title: snippet(it.title, 60) || it.id,
        description: snippet(it.current(), 100),
        input_message_content: { message_text: `ui_edit:${it.id}` },
      })),
      { cache_time: 0, is_personal: true, next_offset: offset + 40 < all.length ? String(offset + 40) : "" },
    ).catch(() => {});
  });
}

export function registerInnerDesign(composer: Composer<NavaContext>) {
  const guard = async (ctx: NavaContext) => {
    if (isOwner(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }).catch(() => {});
    return false;
  };

  composer.on("message", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text?.trim();
    // the marker the inline list sends when an item is tapped: delete it, open the editor in the category screen
    if (text?.startsWith("ui_edit:") && ctx.message.via_bot?.id === ctx.me.id) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      const it = ITEM_BY_ID.get(text.slice(8));
      const flow = await getAdminFlow(ctx.from!.id);
      const p = flow?.flow === FLOW ? (flow.data as unknown as Pending) : {};
      if (!it) return;
      await loadOverrides(true);
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "item", data: { ...p, kind: it.kind, cat: Math.max(0, KIND_CATS[it.kind].indexOf(it.cat)), id: it.id } as any });
      await itemScreen(ctx, it, p.msg);
      return;
    }
    if (text === DESIGN_LABELS.hub) {
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("🎨 طراحی داخلی ربات 👇", { reply_markup: buildDesignHubKeyboard(), ...NOOV });
      return;
    }
    if (text === DESIGN_LABELS.buttons || text === DESIGN_LABELS.texts) {
      await setAdminFlow(ctx.from!.id, null);
      await loadOverrides(true);
      await categories(ctx, text === DESIGN_LABELS.texts ? "text" : "button", 0);
      return;
    }
    if (text === DESIGN_LABELS.photos) {
      await setAdminFlow(ctx.from!.id, null);
      await photosList(ctx, 0);
      return;
    }
    if (text === DESIGN_LABELS.emoji) {
      await setAdminFlow(ctx.from!.id, null);
      const on = !premiumEnabled();
      await setPremiumEnabled(on);
      await logAdminAction(ctx.from!.id, "emoji_premium_toggle", on ? "on" : "off");
      await ctx.reply(`✨ ایموجی پریمیوم ربات: ${on ? "🟢 روشن شد" : "🔴 خاموش شد"}${on && !getOwnerPremium() ? "\n\n⚠️ اکانت مالک پریمیوم نیست؛ تا پریمیوم نشود همان ایموجی‌های ساده نمایش داده می‌شود." : ""}`, { ...NOOV });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    const p = flow.data as unknown as Pending;
    if (text && isFlowCancelSignal(text) && flow.stage !== "browse" && flow.stage !== "item") {
      await endFlow(ctx, p, [ctx.message.message_id]);
      if (p.msg && p.kind !== undefined && flow.stage !== "photo_await") await backToCategory(ctx, p);
      else await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      return;
    }
    // «browse» / «item» are just screens: they must not swallow the owner's other messages
    if (flow.stage === "browse" || flow.stage === "item") return next();
    const again = (m: string) => ctx.reply(m, { reply_markup: cancelKeyboard(), ...NOOV });
    const cleanup = () => ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});

    if (flow.stage === "photo_await") {
      if (!ctx.message.photo) return void (await again("برای این مورد یک «عکس» بفرست."));
      const fileId = ctx.message.photo[ctx.message.photo.length - 1]!.file_id;
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "photo_confirm", data: { ...p, fileId } as any });
      await show(ctx, `🖼 <b>پیش‌نمایش عکس «${escapeHtml(IMAGE_VARS.find((v) => v.key === p.key)?.label ?? "")}»</b>\n\nهمین عکسی که فرستادی جایگزین می‌شود. تأیید می‌کنی؟`, confirmKb(), p.msg);
      return;
    }
    if (!text) return void (await again("لطفاً متن بفرست."));
    const stored = entitiesToSyntax(ctx.message.text ?? "", ctx.message.entities as any);

    if (["text_await", "creply_await", "newreply_await"].includes(flow.stage)) {
      if (stored.length > MAX_TEXT) return void (await again(`متن خیلی بلنده (حداکثر ${MAX_TEXT} نویسه).`));
      const it = flow.stage === "text_await" && p.id ? ITEM_BY_ID.get(p.id) : undefined;
      if (it?.special === "profile") {
        const bad = unknownVars(stored);
        if (bad.length) return void (await again(`این متغیرها وجود ندارند: ${bad.join(" ")}\nمتغیرهای مجاز: ${PROFILE_VARS.map((v) => `{${v}}`).join(" ")}`));
      } else if (it && it.vars.length) {
        const bad = [...stored.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).filter((v) => !it.vars.includes(v));
        if (bad.length) return void (await again(`این متغیرها وجود ندارند: ${bad.map((b) => `{${b}}`).join(" ")}\nمتغیرهای این متن: ${it.vars.map((v) => `{${v}}`).join(" ")}`));
      }
      const next2 = flow.stage === "text_await" ? "text_confirm" : flow.stage === "creply_await" ? "creply_confirm" : "newreply_confirm";
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: next2, data: { ...p, value: stored } as any });
      await cleanup();
      const preview = it?.special === "profile" ? renderTemplate(stored, SAMPLE_PROFILE_VALUES) : emojiSyntaxToHtml(stored.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m0) => m0));
      await show(ctx, `👀 <b>پیش‌نمایش</b> (همان‌طور که کاربر می‌بیند${premiumUsable() ? "" : "؛ پریمیوم الان نمایش داده نمی‌شود"})\n\n${preview}\n\nذخیره بشه؟`, confirmKb(), p.msg);
      return;
    }
    if (flow.stage === "blabel_await" || flow.stage === "newlabel_await") {
      if (stored.length > MAX_LABEL || stored.includes("\n")) return void (await again(`نام دکمه باید یک خط و حداکثر ${MAX_LABEL} نویسه باشد.`));
      await cleanup();
      if (flow.stage === "newlabel_await") {
        await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "newreply_await", data: { ...p, label: stored } as any });
        await show(ctx, `🆕 دکمه‌ی «${escapeHtml(renderButtonLabel(stored, { premium: false }).text)}»\n\nحالا <b>پیامی</b> را بفرست که وقتی کاربر این دکمه را زد ارسال شود.${SYNTAX_HELP}`, inlineKeyboard([]), p.msg);
        return;
      }
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "blabel_confirm", data: { ...p, value: stored } as any });
      const r = renderButtonLabel(stored);
      await show(ctx, `👀 <b>پیش‌نمایش نام دکمه</b>\n\n«${escapeHtml(r.text)}»${r.iconId ? " (با ایموجی پریمیوم)" : ""}\n\nذخیره بشه؟`, confirmKb(), p.msg);
      return;
    }
    return next();
  });

  composer.callbackQuery("ui:no", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    const flow = await getAdminFlow(ctx.from.id);
    const p = flow?.flow === FLOW ? (flow.data as unknown as Pending) : {};
    await endFlow(ctx, p);
    if (p.kind) await backToCategory(ctx, p);
    else await show(ctx, "لغو شد.", inlineKeyboard([]));
  });

  composer.callbackQuery("ui:ok", async (ctx) => {
    if (!(await guard(ctx))) return;
    const flow = await getAdminFlow(ctx.from.id);
    if (!flow || flow.flow !== FLOW) return void (await ctx.answerCallbackQuery({ text: "چیزی برای ذخیره نیست" }));
    const p = flow.data as unknown as Pending;
    const uid = ctx.from.id;
    await ctx.answerCallbackQuery({ text: "✅ ذخیره شد" });
    switch (flow.stage) {
      case "text_confirm": {
        const it = ITEM_BY_ID.get(p.id!)!;
        if (it.special === "content") await setContent(it.id.slice(2) as ContentKey, p.value!, uid);
        else await saveDoc(it.id, { text: p.value! });
        await logAdminAction(uid, "text_set", it.id);
        await endFlow(ctx, p);
        await backToCategory(ctx, p);
        return;
      }
      case "blabel_confirm": {
        if (p.id?.startsWith("c:")) await saveDoc(p.id, { label: p.value! });
        else await saveDoc(p.id!, { text: p.value! });
        await logAdminAction(uid, "button_label_set", p.id!);
        await endFlow(ctx, p);
        if (p.id?.startsWith("c:")) {
          await setAdminFlow(uid, null);
          return void (await customScreen(ctx, p.id.slice(2), p.msg));
        }
        await backToCategory(ctx, p);
        return;
      }
      case "newreply_confirm": {
        const r = await addCustomButton(p.label!, "primary", p.value!);
        await logAdminAction(uid, "button_add", p.label!);
        await endFlow(ctx, p);
        await setAdminFlow(uid, null);
        if (!r.ok) return void (await show(ctx, `حداکثر ${MAX_CUSTOM_BUTTONS} دکمه‌ی جدید مجاز است.`, inlineKeyboard([[glassButton("↩️ بازگشت", "ui:l:b:0", "danger")]]), p.msg));
        await customScreen(ctx, r.id.slice(2), p.msg);
        return;
      }
      case "creply_confirm": {
        await saveDoc(`c:${p.n}`, { reply: p.value! });
        await logAdminAction(uid, "button_reply_set", `c:${p.n}`);
        await endFlow(ctx, p);
        await setAdminFlow(uid, null);
        await customScreen(ctx, p.n!, p.msg);
        return;
      }
      case "photo_confirm":
        await setAppVar(p.key!, p.fileId!);
        await logAdminAction(uid, "var_set", String(p.key));
        await endFlow(ctx, p);
        await setAdminFlow(uid, null);
        await photosList(ctx, 0, p.msg);
        return;
      default:
        return;
    }
  });

  /* ---- navigation ---- */
  composer.callbackQuery(/^ui:l:([tb]):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await loadOverrides(true);
    await setAdminFlow(ctx.from.id, null);
    await categories(ctx, KIND_CODE[ctx.match![1] as "t" | "b"], Number(ctx.match![2]));
  });
  composer.callbackQuery(/^ui:c:([tb]):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await loadOverrides(true);
    const flow = await getAdminFlow(ctx.from.id);
    await endFlow(ctx, flow?.flow === FLOW ? (flow.data as unknown as Pending) : undefined);
    await categoryScreen(ctx, KIND_CODE[ctx.match![1] as "t" | "b"], Number(ctx.match![2]));
  });
  composer.callbackQuery(/^ui:r:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = ctx.match![1]!;
    const it = ITEM_BY_ID.get(id);
    if (!it) return void (await ctx.answerCallbackQuery());
    if (it.special === "content") await clearContent(id.slice(2) as ContentKey);
    else await resetDoc(id);
    await logAdminAction(ctx.from.id, "text_reset", id);
    await ctx.answerCallbackQuery({ text: "♻️ به حالت اول برگشت" });
    const flow = await getAdminFlow(ctx.from.id);
    const p = flow?.flow === FLOW ? (flow.data as unknown as Pending) : {};
    await endFlow(ctx, p);
    await backToCategory(ctx, { ...p, kind: it.kind, cat: Math.max(0, KIND_CATS[it.kind].indexOf(it.cat)), msg: ctx.callbackQuery.message?.message_id });
  });

  // ---- built-in button: rename / colour / hide
  composer.callbackQuery(/^ui:bn:(b.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, `✏️ نام جدید دکمه را بفرست.\n${SYNTAX_HELP.trim()}`, inlineKeyboard([]));
    await begin(ctx, "blabel_await", { id: ctx.match![1]! }, "✍️ نام جدید دکمه را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bc:(b.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const id = ctx.match![1]!;
    const row = (["primary", "success", "danger", "default"] as BtnStyle[]).map((s) => glassButton(STYLE_FA[s], `ui:bs:${id}:${s}`, s === "default" ? "primary" : s));
    await show(ctx, "🎨 رنگ دکمه را انتخاب کن.\nرنگ دکمه در تلگرام فقط: آبی، سبز، قرمز یا پیش‌فرض می‌تواند باشد.", inlineKeyboard([row.slice(0, 2), row.slice(2), [glassButton("↩️ بازگشت", `ui:bi:${id}`, "danger")]]));
  });
  composer.callbackQuery(/^ui:bs:(b[0-9a-f]+):(primary|success|danger|default)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await saveDoc(ctx.match![1]!, { style: ctx.match![2] as BtnStyle });
    await logAdminAction(ctx.from.id, "button_style_set", `${ctx.match![1]}:${ctx.match![2]}`);
    await ctx.answerCallbackQuery({ text: "✅ رنگ عوض شد" });
    const it = ITEM_BY_ID.get(ctx.match![1]!);
    if (it) await itemScreen(ctx, it, ctx.callbackQuery.message?.message_id);
  });
  composer.callbackQuery(/^ui:bi:(b[0-9a-f]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const it = ITEM_BY_ID.get(ctx.match![1]!);
    if (it) await itemScreen(ctx, it, ctx.callbackQuery.message?.message_id);
  });
  composer.callbackQuery(/^ui:bh:(b[0-9a-f]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = ctx.match![1]!;
    await saveDoc(id, { hidden: !getDoc(id)?.hidden });
    await logAdminAction(ctx.from.id, "button_hide_toggle", id);
    await ctx.answerCallbackQuery({ text: "✅ انجام شد" });
    const it = ITEM_BY_ID.get(id);
    if (it) await itemScreen(ctx, it, ctx.callbackQuery.message?.message_id);
  });

  // ---- buttons the owner created
  composer.callbackQuery("ui:cu", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await customList(ctx);
  });
  composer.callbackQuery(/^ui:ce:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await customScreen(ctx, ctx.match![1]!);
  });
  composer.callbackQuery("ui:bnew", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, `🆕 <b>دکمه‌ی جدید</b>\n\nنام دکمه را بفرست (حداکثر ${MAX_LABEL} نویسه).\nرنگ دکمه در تلگرام فقط: آبی، سبز، قرمز یا پیش‌فرض است.`, inlineKeyboard([]));
    await begin(ctx, "newlabel_await", { kind: "button", cat: 0 }, "✍️ نام دکمه را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bn:c:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, "✏️ نام جدید دکمه را بفرست.", inlineKeyboard([]));
    await begin(ctx, "blabel_await", { id: `c:${ctx.match![1]}` }, "✍️ نام جدید دکمه را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bp:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, `💬 پیام جدید این دکمه را بفرست.${SYNTAX_HELP}`, inlineKeyboard([]));
    await begin(ctx, "creply_await", { n: ctx.match![1]! }, "✍️ پیام جدید را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bc:c:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const n = ctx.match![1]!;
    const row = (["primary", "success", "danger", "default"] as BtnStyle[]).map((s) => glassButton(STYLE_FA[s], `ui:cs:${n}:${s}`, s === "default" ? "primary" : s));
    await show(ctx, "🎨 رنگ دکمه را انتخاب کن.", inlineKeyboard([row.slice(0, 2), row.slice(2), [glassButton("↩️ بازگشت", `ui:ce:${n}`, "danger")]]));
  });
  composer.callbackQuery(/^ui:cs:(\d+):(primary|success|danger|default)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await saveDoc(`c:${ctx.match![1]}`, { style: ctx.match![2] as BtnStyle });
    await ctx.answerCallbackQuery({ text: "✅ رنگ عوض شد" });
    await customScreen(ctx, ctx.match![1]!);
  });
  composer.callbackQuery(/^ui:bd:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, "🗑 این دکمه برای همیشه حذف بشه؟", inlineKeyboard([[glassButton("🗑 بله، حذف کن", `ui:bdy:${ctx.match![1]}`, "danger"), glassButton("↩️ نه", `ui:ce:${ctx.match![1]}`, "primary")]]));
  });
  composer.callbackQuery(/^ui:bdy:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await resetDoc(`c:${ctx.match![1]}`);
    await logAdminAction(ctx.from.id, "button_delete", `c:${ctx.match![1]}`);
    await ctx.answerCallbackQuery({ text: "🗑 حذف شد" });
    await customList(ctx);
  });

  // ---- photos
  composer.callbackQuery(/^ui:p:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await photosList(ctx, Number(ctx.match![1]));
  });
  composer.callbackQuery(/^ui:pe:([A-Z0-9_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const def = IMAGE_VARS.find((v) => v.key === ctx.match![1]);
    if (!def) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const cur = await getAppVar(def.key);
    const kb = inlineKeyboard([[glassButton("🔄 تعویض این عکس", `ui:pw:${def.key}`, "success")]]);
    if (cur) await ctx.replyWithPhoto(cur, { caption: `🖼 ${def.label}`, reply_markup: kb, ...NOOV }).catch(() => ctx.reply(`🖼 ${def.label}\n(عکس قابل ارسال نبود)`, { reply_markup: kb, ...NOOV }));
    else await ctx.reply(`🖼 ${def.label}\nهنوز عکسی ثبت نشده.`, { reply_markup: kb, ...NOOV });
  });
  composer.callbackQuery(/^ui:pw:([A-Z0-9_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const def = IMAGE_VARS.find((v) => v.key === ctx.match![1]);
    if (!def) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const sent = await ctx.reply(`🖼 «${def.label}»\nعکس جدید را بفرست.`, { reply_markup: cancelKeyboard(), ...NOOV });
    await setAdminFlow(ctx.from.id, { flow: FLOW, stage: "photo_await", data: { key: def.key, msg: sent.message_id, prompt: sent.message_id } as any });
  });
}

export const designStatusLine = () => `ایموجی پریمیوم: ${premiumEnabled() ? "🟢 روشن" : "🔴 خاموش"} — اکانت مالک: ${getOwnerPremium() ? "✅ پریمیوم" : "❌"}`;
export { CATALOG_BY_ID };
