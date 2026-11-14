import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, glassReplyButton, inlineKeyboard, replyKeyboard, type GlassStyle } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { escapeHtml } from "../../utils/html.js";
import { isOwner } from "./constants.js";
import { ADMIN_CATEGORY_LABELS, ADMIN_MENU_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { clearContent, getContentRaw, setContent, type ContentKey } from "../../db/models/content.js";
import { CONTENT_LABELS, defaultFor } from "./guides.js";
import { IMAGE_VARS } from "./varsAdmin.js";
import { getAppVar, setAppVar } from "../../services/appVars.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { dictionary, dictionaryString, listDictionaryLeaves, type Language } from "../../i18n/index.js";
import { DEFAULT_PROFILE_TEMPLATE, LANGS, LANG_FA, PROFILE_VARS, PROFILE_VAR_HELP, SAMPLE_PROFILE_VALUES, getTextOverride, renderTemplate, saveTextOverride, unknownVars } from "../../services/textOverrides.js";
import { emojiSyntaxToTags } from "../../services/emojiSyntax.js";
import { addCustomButton, builtinOverride, deleteCustom, loadUiButtons, patchBuiltin, patchCustom, resetBuiltin, uiButtons, MAX_CUSTOM_BUTTONS, type BtnStyle } from "../../db/models/uiConfig.js";
import { emojiSyntaxToHtml, emojiSyntaxToPlain, premiumUsable, renderButtonLabel, getOwnerPremium } from "../../services/emojiSyntax.js";
import { premiumEnabled } from "../../config/emojis.js";

/**
 * v1.31.0 «🎨 طراحی داخلی ربات» — the owner's design hub:
 *   🎛 طراحی دکمه‌های ربات   (main reply-keyboard buttons users see: rename, colour, hide, brand-new buttons)
 *   ✨ ایموجی پریمیوم‌ها     (premium emoji switch + per-emoji overrides: emojiAdmin.ts)
 *   ✏️ ویرایش متن‌ها         (متن‌ها / دکمه‌ها / عکس‌ها as 2-column glass lists, paged, edited IN PLACE)
 * Rules: owner only; one message is edited instead of sending new ones; every text input shows the red «لغو» reply button;
 * every text is previewed (exactly as users will see it) and confirmed before saving.
 */
export const DESIGN_LABELS = { buttons: "🎛 طراحی دکمه‌های ربات", edit: "✏️ ویرایش متن‌ها" } as const;
const FLOW = "ui";
const PER_PAGE = 8;
const MAX_TEXT = 3500;
const MAX_LABEL = 40;
const STYLE_FA: Record<BtnStyle, string> = { primary: "🟦 آبی", success: "🟩 سبز", danger: "🟥 قرمز", default: "⬜ پیش‌فرض" };

type Markup = ReturnType<typeof inlineKeyboard>;

export function buildDesignHubKeyboard() {
  return replyKeyboard([
    [glassReplyButton(DESIGN_LABELS.buttons, "primary"), glassReplyButton(ADMIN_MENU_LABELS.emojis, "success")],
    [glassReplyButton(DESIGN_LABELS.edit, "primary")],
    [glassReplyButton(ADMIN_CATEGORY_LABELS.back, "danger")],
  ]);
}

async function showScreen(ctx: NavaContext, text: string, kb: Markup, msg?: number): Promise<number | undefined> {
  const o = { parse_mode: "HTML" as const, reply_markup: kb };
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
  const sent = await ctx.reply(text, o);
  return sent.message_id;
}

const pageRows = (items: Array<{ label: string; cb: string; style: GlassStyle }>, page: number, prefix: string) => {
  items = items.map((x, i) => ({ ...x, cb: x.cb.replace("@P", String(Math.floor(i / PER_PAGE))) }));
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
export async function openEditHub(ctx: NavaContext, msg?: number) {
  return showScreen(
    ctx,
    "✏️ <b>ویرایش متن‌ها</b>\n\nچی رو می‌خوای ویرایش کنی؟",
    inlineKeyboard([[glassButton("📝 ویرایش متن‌ها", "ui:t:0", "primary"), glassButton("🎛 ویرایش دکمه‌ها", "ui:b:0", "success")], [glassButton("🖼 ویرایش عکس‌ها", "ui:p:0", "primary")]]),
    msg,
  );
}

/* ---- every editable text, per language ---- */
type Group = "text" | "button";
interface Target {
  group: Group;
  kind: "c" | "p" | "d";
  ref: string;
  label: string;
}
const SECTION_FA: Record<string, string> = { onboarding: "شروع", forceJoin: "عضویت اجباری", matching: "چت", languageButtons: "زبان", errors: "خطا", relic: "ژتون", photo: "عکس", profile: "پروفایل" };
const snippet = (t: string) => t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 18);
const TARGETS: Target[] = (() => {
  const out: Target[] = (Object.keys(CONTENT_LABELS) as ContentKey[]).map((k) => ({ group: "text" as Group, kind: "c" as const, ref: k, label: CONTENT_LABELS[k] }));
  out.push({ group: "text", kind: "p", ref: "profileCard", label: "🪪 کارت پروفایل" });
  for (const l of listDictionaryLeaves()) {
    const top = l.path.split(".")[0]!;
    if (top === "mainMenu" || l.text.trim() === "" || `ui:tl:${out.length}:fa:99`.length > 64) continue;
    const isBtn = /button/i.test(l.path);
    out.push({ group: isBtn ? "button" : "text", kind: "d", ref: l.path, label: `${SECTION_FA[top] ?? top} › ${snippet(l.text)}` });
  }
  return out;
})();

const targetRaw = async (t: Target, lang: Language): Promise<string> => {
  if (t.kind === "c") return (await getContentRaw(t.ref as ContentKey, lang)) ?? (lang === "fa" ? defaultFor(t.ref as ContentKey) : "");
  if (t.kind === "p") return (await getTextOverride(`t:profileCard:${lang}`)) ?? DEFAULT_PROFILE_TEMPLATE;
  return (await getTextOverride(`d:${lang}:${t.ref}`)) ?? dictionaryString(lang, t.ref) ?? "";
};
const targetSave = async (t: Target, lang: Language, text: string, uid: number) => {
  if (t.kind === "c") await setContent(t.ref as ContentKey, text, uid, lang);
  else if (t.kind === "p") await saveTextOverride(`t:profileCard:${lang}`, text);
  else await saveTextOverride(`d:${lang}:${t.ref}`, emojiSyntaxToTags(text));
};
const targetReset = async (t: Target, lang: Language) => {
  if (t.kind === "c") await clearContent(t.ref as ContentKey, lang);
  else await saveTextOverride(t.kind === "p" ? `t:profileCard:${lang}` : `d:${lang}:${t.ref}`, null);
};
const targetPreview = (t: Target, text: string) => (t.kind === "p" ? renderTemplate(text, SAMPLE_PROFILE_VALUES) : emojiSyntaxToHtml(text));
const targetIndex = (t: Target) => TARGETS.indexOf(t);

async function textsList(ctx: NavaContext, page: number, msg?: number) {
  const items = TARGETS.filter((t) => t.group === "text").map((t) => ({ label: t.label, cb: `ui:tg:${targetIndex(t)}:@P`, style: "primary" as GlassStyle }));
  items.unshift({ label: "🛒 منوی خرید", cb: "adm:shop:home", style: "success" });
  const { rows, pg, pages } = pageRows(items, page, "ui:t:");
  rows.push([glassButton("↩️ بازگشت", "ui:home", "danger")]);
  return showScreen(ctx, `📝 <b>متن‌ها</b> (صفحه ${pg + 1} از ${pages})\n\nیکی رو انتخاب کن، بعد زبانش:`, inlineKeyboard(rows), msg);
}

async function langPicker(ctx: NavaContext, i: number, page: number, msg?: number) {
  const t = TARGETS[i]!;
  const row = LANGS.map((l) => glassButton(LANG_FA[l], `ui:tl:${i}:${l}:${page}`, "primary"));
  return showScreen(ctx, `🌐 <b>${escapeHtml(t.label)}</b>\n\nکدام زبانش را ویرایش کنم؟`, inlineKeyboard([row, [glassButton("↩️ بازگشت", t.group === "text" ? `ui:t:${page}` : `ui:b:${page}`, "danger")]]), msg);
}

const builtinKeys = () => Object.keys(MENU_CALLBACKS) as Array<keyof typeof MENU_CALLBACKS>;
const builtinLabel = (key: string) => String(builtinOverride(key)?.label ?? (dictionary("fa").mainMenu as Record<string, string>)[key] ?? key);
const plain = (raw: string) => renderButtonLabel(raw, { premium: false }).text;

async function buttonsList(ctx: NavaContext, page: number, msg?: number) {
  await loadUiButtons(true);
  const items = builtinKeys().map((k) => {
    const o = builtinOverride(k);
    return { label: `${o?.hidden ? "🚫 " : ""}${plain(builtinLabel(k))}`, cb: `ui:be:b:${k}`, style: "primary" as GlassStyle };
  });
  for (const c of uiButtons().filter((b) => b.custom)) items.push({ label: `🆕 ${plain(c.label ?? "—")}`, cb: `ui:be:c:${c._id.slice(2)}`, style: "success" });
  for (const t of TARGETS.filter((x) => x.group === "button")) items.push({ label: `🔘 ${t.label}`, cb: `ui:tg:${targetIndex(t)}:@P`, style: "primary" });
  const { rows, pg, pages } = pageRows(items, page, "ui:b:");
  rows.push([glassButton("➕ دکمه‌ی جدید", "ui:bnew", "success")]);
  rows.push([glassButton("↩️ بازگشت", "ui:home", "danger")]);
  return showScreen(
    ctx,
    `🎛 <b>دکمه‌های منوی اصلی ربات</b> (صفحه ${pg + 1} از ${pages})\n\n🚫 یعنی برای کاربران مخفیه، 🆕 یعنی دکمه‌ای که خودت ساختی، 🔘 یعنی دکمه‌ی زیر پیام‌ها. یکی رو بزن:`,
    inlineKeyboard(rows),
    msg,
  );
}

const refOf = (kind: string, id: string) => (kind === "b" ? `b:${id}` : `c:${id}`);

async function buttonDetail(ctx: NavaContext, kind: string, id: string, msg?: number) {
  await loadUiButtons(true);
  const ref = refOf(kind, id);
  const rows: any[][] = [];
  let text: string;
  if (kind === "b") {
    const o = builtinOverride(id);
    text = `🎛 <b>${escapeHtml(plain(builtinLabel(id)))}</b>\n\nرنگ: ${STYLE_FA[o?.style ?? "primary"]}${o?.style ? "" : " (پیش‌فرض ربات)"}\nوضعیت: ${o?.hidden ? "🚫 مخفی" : "✅ نمایش داده می‌شود"}`;
    rows.push([glassButton("✏️ تغییر نام", `ui:bn:${ref}`, "primary"), glassButton("🎨 تغییر رنگ", `ui:bc:${ref}`, "primary")]);
    rows.push([glassButton(o?.hidden ? "👁 نمایش بده" : "🚫 مخفی کن", `ui:bh:${ref}`, "success"), glassButton("♻️ بازنشانی", `ui:br:${ref}`, "danger")]);
  } else {
    const c = uiButtons().find((b) => b._id === ref);
    if (!c) return buttonsList(ctx, 0, msg);
    text = `🆕 <b>${escapeHtml(plain(c.label ?? "—"))}</b>\n\nرنگ: ${STYLE_FA[c.style ?? "primary"]}\n\n<b>پیامی که بعد از زدن ارسال می‌شود:</b>\n${emojiSyntaxToHtml((c.reply ?? "").slice(0, 1500))}`;
    rows.push([glassButton("✏️ تغییر نام", `ui:bn:${ref}`, "primary"), glassButton("🎨 تغییر رنگ", `ui:bc:${ref}`, "primary")]);
    rows.push([glassButton("💬 تغییر پیام", `ui:bp:${ref}`, "success"), glassButton("🗑 حذف", `ui:bd:${ref}`, "danger")]);
  }
  rows.push([glassButton("↩️ بازگشت", "ui:b:0", "danger")]);
  return showScreen(ctx, text, inlineKeyboard(rows), msg);
}

async function photosList(ctx: NavaContext, page: number, msg?: number) {
  const items: Array<{ label: string; cb: string; style: GlassStyle }> = [];
  for (const v of IMAGE_VARS) items.push({ label: `${(await getAppVar(v.key)) ? "✅" : "➕"} ${v.label}`, cb: `ui:pe:${v.key}`, style: (await getAppVar(v.key)) ? "primary" : "success" });
  const { rows, pg, pages } = pageRows(items, page, "ui:p:");
  rows.push([glassButton("↩️ بازگشت", "ui:home", "danger")]);
  return showScreen(ctx, `🖼 <b>عکس‌های ربات</b> (صفحه ${pg + 1} از ${pages})\n\nروی هر عکس بزن تا برات فرستاده بشه و بتونی عوضش کنی. ✅ = ثبت شده، ➕ = هنوز ندارد.`, inlineKeyboard(rows), msg);
}

/* ------------------------------------------------------------------ input flows */
interface Pending {
  kind: "text" | "blabel" | "newlabel" | "newreply" | "creply" | "photo";
  key?: string;
  ref?: string;
  label?: string;
  value?: string;
  fileId?: string;
  target?: number;
  lang?: Language;
  page?: number;
  msg?: number;
  prompt?: number;
}

async function begin(ctx: NavaContext, stage: string, p: Pending, ask: string) {
  const prompt = await ctx.reply(ask, { reply_markup: cancelKeyboard() });
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage, data: { ...p, msg: p.msg ?? ctx.callbackQuery?.message?.message_id, prompt: prompt.message_id } as any });
}

async function endFlow(ctx: NavaContext, p?: Pending, extraDelete: number[] = []) {
  await setAdminFlow(ctx.from!.id, null);
  for (const id of [p?.prompt, ...extraDelete]) if (id) await ctx.api.deleteMessage(ctx.chat!.id, id).catch(() => {});
}

const confirmKb = () => inlineKeyboard([[glassButton("✅ تأیید و ذخیره", "ui:ok", "success"), glassButton("❌ لغو", "ui:no", "danger")]]);
const COLOR_HINT = "رنگ دکمه در تلگرام فقط: آبی، سبز، قرمز یا پیش‌فرض می‌تواند باشد.";

const SYNTAX_HELP = "\n\nایموجی پریمیوم: <code>-😌 -شناسه_عددی-</code> (اگر پریمیوم خاموش یا اکانت مالک پریمیوم نباشد، ایموجی معمولی دیده می‌شود). اینتر = خط جدید.";

export function registerInnerDesign(composer: Composer<NavaContext>) {
  const guard = async (ctx: NavaContext) => {
    if (isOwner(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }).catch(() => {});
    return false;
  };

  /* ---- reply-keyboard entry points + text / forwarded input ---- */
  composer.on("message", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text?.trim();
    if (text === ADMIN_MENU_LABELS.innerDesign) {
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("🎨 طراحی داخلی ربات 👇", { reply_markup: buildDesignHubKeyboard() });
      return;
    }
    if (text === DESIGN_LABELS.buttons) {
      await setAdminFlow(ctx.from!.id, null);
      await buttonsList(ctx, 0);
      return;
    }
    if (text === DESIGN_LABELS.edit) {
      await setAdminFlow(ctx.from!.id, null);
      await openEditHub(ctx);
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    const p = flow.data as unknown as Pending;
    if (text && isFlowCancelSignal(text)) {
      await endFlow(ctx, p, [ctx.message.message_id]);
      if (p.msg) await showScreen(ctx, "لغو شد.", inlineKeyboard([[glassButton("↩️ بازگشت", "ui:home", "danger")]]), p.msg);
      if (text.startsWith("/")) return next();
      return;
    }
    const cleanup = () => ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    const again = (msg: string) => ctx.reply(msg, { reply_markup: cancelKeyboard() });

    if (flow.stage === "photo_await") {
      if (!ctx.message.photo) return void (await again("برای این مورد یک «عکس» بفرست."));
      const fileId = ctx.message.photo[ctx.message.photo.length - 1]!.file_id;
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "photo_confirm", data: { ...p, fileId } as any });
      await showScreen(ctx, `🖼 <b>پیش‌نمایش عکس «${escapeHtml(IMAGE_VARS.find((v) => v.key === p.key)?.label ?? "")}»</b>\n\nعکس بالا (همین که فرستادی) جایگزین می‌شود. تأیید می‌کنی؟`, confirmKb(), p.msg);
      return;
    }
    if (!text) return void (await again("لطفاً متن بفرست."));

    if (flow.stage === "text_await" || flow.stage === "creply_await" || flow.stage === "newreply_await") {
      if (text.length > MAX_TEXT) return void (await again(`متن خیلی بلنده (حداکثر ${MAX_TEXT} نویسه).`));
      const tg = flow.stage === "text_await" && p.target !== undefined ? TARGETS[p.target] : undefined;
      if (tg?.kind === "p") {
        const bad = unknownVars(text);
        if (bad.length) return void (await again(`این متغیرها وجود ندارند: ${bad.join(" ")}\nمتغیرهای مجاز: ${PROFILE_VARS.map((v) => `{${v}}`).join(" ")}`));
      }
      const next2 = flow.stage === "text_await" ? "text_confirm" : flow.stage === "creply_await" ? "creply_confirm" : "newreply_confirm";
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: next2, data: { ...p, value: text } as any });
      await cleanup();
      await showScreen(ctx, `👀 <b>پیش‌نمایش</b> (همان‌طور که کاربر می‌بیند)\n\n${tg ? targetPreview(tg, text) : emojiSyntaxToHtml(text)}\n\nذخیره بشه؟`, confirmKb(), p.msg);
      return;
    }
    if (flow.stage === "blabel_await" || flow.stage === "newlabel_await") {
      if (text.length > MAX_LABEL) return void (await again(`نام دکمه حداکثر ${MAX_LABEL} نویسه است.`));
      if (text.includes("\n")) return void (await again("نام دکمه باید یک خط باشد."));
      await cleanup();
      if (flow.stage === "newlabel_await") {
        await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "newreply_await", data: { ...p, label: text } as any });
        await showScreen(ctx, `🆕 دکمه‌ی «${escapeHtml(plain(text))}»\n\nحالا <b>پیامی</b> را بفرست که وقتی کاربر این دکمه را زد ارسال شود.${SYNTAX_HELP}`, inlineKeyboard([]), p.msg);
        return;
      }
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "blabel_confirm", data: { ...p, value: text } as any });
      await showScreen(ctx, `👀 <b>پیش‌نمایش نام دکمه</b>\n\n«${escapeHtml(renderButtonLabel(text).text)}»${renderButtonLabel(text).iconId ? " (با ایموجی پریمیوم)" : ""}\n\nذخیره بشه؟`, confirmKb(), p.msg);
      return;
    }
    return next();
  });

  /* ---- confirm / cancel ---- */
  composer.callbackQuery("ui:no", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery({ text: "لغو شد" });
    const flow = await getAdminFlow(ctx.from!.id);
    await endFlow(ctx, flow?.flow === FLOW ? (flow.data as unknown as Pending) : undefined);
    await openEditHub(ctx);
  });

  composer.callbackQuery("ui:ok", async (ctx) => {
    if (!(await guard(ctx))) return;
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return void (await ctx.answerCallbackQuery({ text: "چیزی برای ذخیره نیست" }));
    const p = flow.data as unknown as Pending;
    await ctx.answerCallbackQuery({ text: "✅ ذخیره شد" });
    const uid = ctx.from.id;
    switch (flow.stage) {
      case "text_confirm":
        {
          const tg = TARGETS[p.target!]!;
          await targetSave(tg, p.lang!, p.value!, uid);
          await logAdminAction(uid, "text_set", `${tg.ref}:${p.lang}`);
          await endFlow(ctx, p);
          // straight back to the list (same page) so the next text is one tap away
          await (tg.group === "text" ? textsList(ctx, p.page ?? 0, p.msg) : buttonsList(ctx, p.page ?? 0, p.msg));
        }
        return;
      case "blabel_confirm": {
        const [k, id] = p.ref!.split(":") as [string, string];
        if (k === "b") await patchBuiltin(id, { label: p.value! });
        else await patchCustom(p.ref!, { label: p.value! });
        await logAdminAction(uid, "button_label_set", p.ref!);
        await endFlow(ctx, p);
        await buttonDetail(ctx, k, id, p.msg);
        return;
      }
      case "newreply_confirm": {
        const r = await addCustomButton(p.label!, "primary", p.value!);
        await logAdminAction(uid, "button_add", p.label!);
        await endFlow(ctx, p);
        if (!r.ok) return void (await showScreen(ctx, `حداکثر ${MAX_CUSTOM_BUTTONS} دکمه‌ی جدید مجاز است.`, inlineKeyboard([[glassButton("↩️ بازگشت", "ui:b:0", "danger")]]), p.msg));
        await buttonDetail(ctx, "c", r.id.slice(2), p.msg);
        return;
      }
      case "creply_confirm": {
        await patchCustom(p.ref!, { reply: p.value! });
        await logAdminAction(uid, "button_reply_set", p.ref!);
        await endFlow(ctx, p);
        await buttonDetail(ctx, "c", p.ref!.slice(2), p.msg);
        return;
      }
      case "photo_confirm":
        await setAppVar(p.key!, p.fileId!);
        await logAdminAction(uid, "var_set", String(p.key));
        await endFlow(ctx, p);
        await photosList(ctx, 0, p.msg);
        return;
      default:
        return;
    }
  });

  /* ---- navigation ---- */
  composer.callbackQuery("ui:home", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await openEditHub(ctx);
  });
  composer.callbackQuery(/^ui:t:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await textsList(ctx, Number(ctx.match![1]));
  });
  composer.callbackQuery(/^ui:tg:(\d+):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const i = Number(ctx.match![1]);
    if (!TARGETS[i]) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await langPicker(ctx, i, Number(ctx.match![2]));
  });
  composer.callbackQuery(/^ui:tl:(\d+):(fa|en|ar):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const i = Number(ctx.match![1]);
    const tg = TARGETS[i];
    if (!tg) return void (await ctx.answerCallbackQuery());
    const lang = ctx.match![2] as Language;
    const page = Number(ctx.match![3]);
    await ctx.answerCallbackQuery();
    const cur = await targetRaw(tg, lang);
    const shown = cur.length > 1200 ? cur.slice(0, 1200) + "…" : cur;
    const vars = tg.kind === "p" ? `\n\n<b>متغیرها</b> (همین‌ها را دست نزن، فقط متن اطرافشان را عوض کن):\n${PROFILE_VARS.map((v) => `<code>{${v}}</code> ${PROFILE_VAR_HELP[v]}`).join("\n")}\nخطی که متغیرش خالی باشد خودکار حذف می‌شود.` : "";
    await showScreen(
      ctx,
      `✍️ <b>${escapeHtml(tg.label)}</b> — ${LANG_FA[lang]}\n\n<b>متن فعلی:</b>\n<pre>${escapeHtml(shown || "(خالی)")}</pre>${vars}${SYNTAX_HELP}\n\nمتن جدید را بفرست 👇`,
      inlineKeyboard([[glassButton("♻️ بازنشانی به پیش‌فرض", `ui:tr:${i}:${lang}:${page}`, "danger"), glassButton("↩️ بازگشت", `ui:tg:${i}:${page}`, "primary")]]),
    );
    await begin(ctx, "text_await", { kind: "text", target: i, lang, page }, `✍️ متن جدید «${tg.label}» (${LANG_FA[lang]}) را بفرست`);
  });
  composer.callbackQuery(/^ui:tr:(\d+):(fa|en|ar):(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const tg = TARGETS[Number(ctx.match![1])];
    if (!tg) return void (await ctx.answerCallbackQuery());
    const flow = await getAdminFlow(ctx.from.id);
    await endFlow(ctx, flow?.flow === FLOW ? (flow.data as unknown as Pending) : undefined);
    await targetReset(tg, ctx.match![2] as Language);
    await logAdminAction(ctx.from.id, "text_reset", `${tg.ref}:${ctx.match![2]}`);
    await ctx.answerCallbackQuery({ text: "♻️ بازنشانی شد" });
    await (tg.group === "text" ? textsList(ctx, Number(ctx.match![3])) : buttonsList(ctx, Number(ctx.match![3])));
  });

  composer.callbackQuery(/^ui:b:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await buttonsList(ctx, Number(ctx.match![1]));
  });
  composer.callbackQuery(/^ui:be:([bc]):(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const [, kind, id] = ctx.match! as unknown as [string, string, string];
    if (kind === "b" && !(id in MENU_CALLBACKS)) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await buttonDetail(ctx, kind, id);
  });
  composer.callbackQuery("ui:bnew", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `🆕 <b>دکمه‌ی جدید</b>\n\nنام دکمه را بفرست (حداکثر ${MAX_LABEL} نویسه، مثلاً <code>-😌 -شناسه-پروفایل</code>).\n${COLOR_HINT}`, inlineKeyboard([]));
    await begin(ctx, "newlabel_await", { kind: "newlabel" }, "✍️ نام دکمه را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bn:([bc]:\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const ref = ctx.match![1]!;
    await showScreen(ctx, `✏️ نام جدید دکمه را بفرست.\n(سینتکس ایموجی هم کار می‌کند: <code>-😌 -شناسه-پروفایل</code>)`, inlineKeyboard([]));
    await begin(ctx, "blabel_await", { kind: "blabel", ref }, "✍️ نام جدید دکمه را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bp:(c:\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `💬 پیام جدید این دکمه را بفرست.${SYNTAX_HELP}`, inlineKeyboard([]));
    await begin(ctx, "creply_await", { kind: "creply", ref: ctx.match![1]! }, "✍️ پیام جدید را بفرست (یا «لغو»)");
  });
  composer.callbackQuery(/^ui:bc:([bc]:\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const ref = ctx.match![1]!;
    const row = (["primary", "success", "danger", "default"] as BtnStyle[]).map((s) => glassButton(STYLE_FA[s], `ui:bs:${ref}:${s}`, s === "default" ? "primary" : s));
    await showScreen(ctx, `🎨 رنگ دکمه را انتخاب کن.\n${COLOR_HINT}`, inlineKeyboard([row.slice(0, 2), row.slice(2), [glassButton("↩️ بازگشت", `ui:be:${ref}`, "danger")]]));
  });
  composer.callbackQuery(/^ui:bs:([bc]):(\w+):(primary|success|danger|default)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const [, kind, id, style] = ctx.match! as unknown as [string, string, string, BtnStyle];
    if (kind === "b") await patchBuiltin(id, { style });
    else await patchCustom(`c:${id}`, { style });
    await logAdminAction(ctx.from.id, "button_style_set", `${kind}:${id}:${style}`);
    await ctx.answerCallbackQuery({ text: "✅ رنگ عوض شد" });
    await buttonDetail(ctx, kind, id);
  });
  composer.callbackQuery(/^ui:bh:b:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = ctx.match![1]!;
    if (!(id in MENU_CALLBACKS)) return void (await ctx.answerCallbackQuery());
    await patchBuiltin(id, { hidden: !builtinOverride(id)?.hidden });
    await logAdminAction(ctx.from.id, "button_hide_toggle", id);
    await ctx.answerCallbackQuery({ text: "✅ انجام شد" });
    await buttonDetail(ctx, "b", id);
  });
  composer.callbackQuery(/^ui:br:b:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const id = ctx.match![1]!;
    await resetBuiltin(id);
    await logAdminAction(ctx.from.id, "button_reset", id);
    await ctx.answerCallbackQuery({ text: "♻️ به حالت اول برگشت" });
    await buttonDetail(ctx, "b", id);
  });
  composer.callbackQuery(/^ui:bd:c:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const id = ctx.match![1]!;
    await showScreen(ctx, "🗑 این دکمه برای همیشه حذف بشه؟", inlineKeyboard([[glassButton("🗑 بله، حذف کن", `ui:bdy:${id}`, "danger"), glassButton("↩️ نه", `ui:be:c:${id}`, "primary")]]));
  });
  composer.callbackQuery(/^ui:bdy:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await deleteCustom(`c:${ctx.match![1]}`);
    await logAdminAction(ctx.from.id, "button_delete", ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "🗑 حذف شد" });
    await buttonsList(ctx, 0);
  });

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
    const kb = inlineKeyboard([[glassButton("🔄 تعویض این عکس", `ui:pw:${def.key}`, "success"), glassButton("↩️ بازگشت", "ui:p:0", "danger")]]);
    if (cur) await ctx.replyWithPhoto(cur, { caption: `🖼 ${def.label}`, reply_markup: kb }).catch(() => ctx.reply(`🖼 ${def.label}\n(عکس قابل ارسال نبود)`, { reply_markup: kb }));
    else await ctx.reply(`🖼 ${def.label}\nهنوز عکسی ثبت نشده.`, { reply_markup: kb });
  });
  composer.callbackQuery(/^ui:pw:([A-Z0-9_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const def = IMAGE_VARS.find((v) => v.key === ctx.match![1]);
    if (!def) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const sent = await ctx.reply(`🖼 «${def.label}»\nعکس جدید را بفرست.`, { reply_markup: cancelKeyboard() });
    await setAdminFlow(ctx.from.id, { flow: FLOW, stage: "photo_await", data: { kind: "photo", key: def.key, msg: sent.message_id, prompt: sent.message_id } as any });
  });
}

export const designStatusLine = () =>
  `وضعیت ایموجی پریمیوم: ${premiumEnabled() ? "🟢 روشن" : "🔴 خاموش"} — اکانت مالک: ${getOwnerPremium() ? "✅ پریمیوم" : "❌ پریمیوم نیست"} → ${premiumUsable() ? "پریمیوم نمایش داده می‌شود" : "ایموجی معمولی نمایش داده می‌شود"}`;
export { emojiSyntaxToPlain };
