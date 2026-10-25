import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import {
  addShopButton, getShopConfig, moveShopButton, removeShopButton, setShopText, updateShopButton,
  type ShopButton, type ShopColor, type ShopSection,
} from "../../db/models/shopConfig.js";
import { starsButtons } from "../shop/shop.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { canAdmin } from "./permissions.js";
import { toAsciiDigits } from "../../utils/digits.js";

/**
 * «🛒 منوی خرید» — the owner edits everything the user sees after tapping «ژتون»:
 * the texts of each screen, and any number of buttons (text, colour, link — or «pay N Stars → get M ژتون»).
 * All screens are ONE message that is edited in place; text input goes through the red reply-keyboard «❌ لغو».
 */
const P = "adm:shop:";
const FLOW = "shop";
const COLOR_LABEL: Record<ShopColor, string> = { primary: "🔵 آبی", success: "🟢 سبز", danger: "🔴 قرمز" };
const COLORS: ShopColor[] = ["primary", "success", "danger"];
const SECTION_LABEL: Record<ShopSection, string> = { stars: "⭐ استارز", jeton: "🪙 ژتون" };

const ok = (ctx: NavaContext) => canAdmin(ctx, "pricing");
const dot = (c: ShopColor) => (c === "primary" ? "🔵" : c === "success" ? "🟢" : "🔴");

async function homeView() {
  const cfg = await getShopConfig();
  return {
    text:
      "🛒 <b>منوی خرید</b>\n\nوقتی کاربر دکمه‌ی «ژتون» رو می‌زنه این صفحه‌ها رو می‌بینه. همه چیز یه پیام هست که ادیت میشه.\n\n" +
      `<b>متن اصلی:</b>\n<blockquote>${escapeHtml(cfg.mainText)}</blockquote>\n` +
      "(توی متن اصلی <code>{balance}</code> = موجودی کاربر)\n\n" +
      `⭐ دکمه‌های استارز: ${cfg.stars.buttons.length || "پیش‌فرض (پکیج‌های قیمت)"}\n🪙 دکمه‌های ژتون: ${cfg.jeton.buttons.length}`,
    kb: inlineKeyboard([
      [glassButton("✏️ متن اصلی", `${P}t:main`, "primary")],
      [glassButton("⭐ بخش استارز", `${P}s:stars`, "success"), glassButton("🪙 بخش ژتون", `${P}s:jeton`, "success")],
      [glassButton("📥 متن بخش آدرس ولت", `${P}t:wallet`, "primary")],
    ]),
  };
}

async function sectionView(section: ShopSection) {
  const cfg = await getShopConfig();
  const buttons = section === "stars" ? await starsButtons(cfg.stars.buttons) : cfg.jeton.buttons;
  const legacy = section === "stars" && cfg.stars.buttons.length === 0;
  const rows = buttons.map((b) => [glassButton(`${dot(b.color)} ${b.label}`, legacy ? `${P}x:legacy` : `${P}b:${section}:${b.id}`, "primary")]);
  return {
    text:
      `${SECTION_LABEL[section]}\n\n<b>متن این صفحه:</b>\n<blockquote>${escapeHtml(cfg[section].text)}</blockquote>\n` +
      (legacy ? "الان پکیج‌های «تنظیم قیمت» نشون داده میشن. با «➕ دکمه‌ی جدید» دکمه‌های خودت رو بساز؛ از اون لحظه فقط دکمه‌های خودت نمایش داده میشن.\n" : "") +
      `\nدکمه‌ها (${buttons.length}) — برای ویرایش روی هرکدوم بزن:`,
    kb: inlineKeyboard([...rows, [glassButton("➕ دکمه‌ی جدید", `${P}a:${section}`, "success"), glassButton("✏️ متن صفحه", `${P}t:${section}`, "primary")], [glassButton("🔙 بازگشت", `${P}home`, "danger")]]),
  };
}

function describe(b: ShopButton): string {
  return b.kind === "url" ? `🔗 لینک: <code>${escapeHtml(b.url ?? "")}</code>` : `⭐ پرداخت ${b.price} استارز ← ${b.relic} ژتون`;
}

async function buttonView(section: ShopSection, id: string) {
  const cfg = await getShopConfig();
  const b = cfg[section].buttons.find((x) => x.id === id);
  if (!b) return null;
  return {
    text: `${SECTION_LABEL[section]} ← دکمه\n\nمتن: <b>${escapeHtml(b.label)}</b>\nرنگ: ${COLOR_LABEL[b.color]}\n${describe(b)}`,
    kb: inlineKeyboard([
      [glassButton("🎨 تغییر رنگ", `${P}c:${section}:${id}`, "primary"), glassButton("✏️ متن دکمه", `${P}e:${section}:${id}:label`, "primary")],
      [glassButton(b.kind === "url" ? "🔗 تغییر لینک" : "⭐ تغییر قیمت/ژتون", `${P}e:${section}:${id}:${b.kind === "url" ? "url" : "stars"}`, "primary")],
      [glassButton("⬆️", `${P}m:${section}:${id}:-1`, "success"), glassButton("⬇️", `${P}m:${section}:${id}:1`, "success"), glassButton("🗑 حذف", `${P}d:${section}:${id}`, "danger")],
      [glassButton("🔙 بازگشت", `${P}s:${section}`, "danger")],
    ]),
  };
}

type View = { text: string; kb: ReturnType<typeof inlineKeyboard> } | null;

async function render(ctx: NavaContext, v: View, edit: boolean) {
  if (!v) return void (await ctx.reply("پیدا نشد."));
  const o = { parse_mode: "HTML" as const, reply_markup: v.kb, link_preview_options: { is_disabled: true } };
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

const askText = (which: string) =>
  which === "main"
    ? "متن جدید صفحه‌ی اصلی رو بفرست.\nمی‌تونی از <code>{balance}</code> برای نمایش موجودی کاربر استفاده کنی."
    : "متن جدید این صفحه رو بفرست.";

export function registerShopAdmin(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text === ADMIN_MENU_LABELS.shop) {
      if (!ok(ctx)) return next();
      await setAdminFlow(ctx.from!.id, null);
      await render(ctx, await homeView(), false);
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (!ok(ctx)) return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    const d = (flow.data ?? {}) as Record<string, any>;
    const adminId = ctx.from!.id;

    // ---- plain text of a screen
    if (flow.stage === "text") {
      if (text.length < 1 || text.length > 1500) return void (await ctx.reply("متن باید بین ۱ تا ۱۵۰۰ حرف باشه.", { reply_markup: cancelKeyboard() }));
      await setShopText(d.which, ctx.message.text);
      await setAdminFlow(adminId, null);
      await logAdminAction(adminId, "shop_text", String(d.which));
      await ctx.reply("✅ ذخیره شد.");
      await render(ctx, d.which === "stars" || d.which === "jeton" ? await sectionView(d.which) : await homeView(), false);
      return;
    }

    // ---- new button details (one message, one value per line)
    const lines = ctx.message.text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (flow.stage === "new") {
      const section = d.section as ShopSection;
      const kind = d.kind as "url" | "stars";
      try {
        if (kind === "url") {
          if (lines.length < 2) return void (await ctx.reply("دو خط بفرست:\nمتن دکمه\nلینک", { reply_markup: cancelKeyboard() }));
          await addShopButton(section, { kind, label: lines[0]!, color: d.color, url: lines[1]! });
        } else {
          if (lines.length < 3) return void (await ctx.reply("سه خط بفرست:\nمتن دکمه\nقیمت به استارز\nتعداد ژتونی که کاربر می‌گیره", { reply_markup: cancelKeyboard() }));
          await addShopButton(section, { kind, label: lines[0]!, color: d.color, price: Number(toAsciiDigits(lines[1]!)), relic: Number(toAsciiDigits(lines[2]!)) });
        }
      } catch (err: any) {
        return void (await ctx.reply(`❌ ${err?.message ?? "نامعتبر"}\nدوباره بفرست یا لغو کن.`, { reply_markup: cancelKeyboard() }));
      }
      await setAdminFlow(adminId, null);
      await logAdminAction(adminId, "shop_button_add", `${section}:${lines[0]}`);
      await ctx.reply("✅ دکمه اضافه شد.");
      await render(ctx, await sectionView(section), false);
      return;
    }

    // ---- edit one field of an existing button
    if (flow.stage === "edit") {
      const { section, id, field } = d as { section: ShopSection; id: string; field: "label" | "url" | "stars" };
      let patch: Partial<ShopButton>;
      if (field === "label") patch = { label: lines[0] ?? "" };
      else if (field === "url") patch = { url: lines[0] ?? "" };
      else {
        if (lines.length < 2) return void (await ctx.reply("دو خط بفرست:\nقیمت به استارز\nتعداد ژتون", { reply_markup: cancelKeyboard() }));
        patch = { price: Number(toAsciiDigits(lines[0]!)), relic: Number(toAsciiDigits(lines[1]!)) };
      }
      const err = await updateShopButton(section, id, patch);
      if (err) return void (await ctx.reply(`❌ ${err}\nدوباره بفرست یا لغو کن.`, { reply_markup: cancelKeyboard() }));
      await setAdminFlow(adminId, null);
      await logAdminAction(adminId, "shop_button_edit", `${section}:${id}:${field}`);
      await ctx.reply("✅ ذخیره شد.");
      await render(ctx, await buttonView(section, id), false);
      return;
    }
    return next();
  });

  const guard = async (ctx: NavaContext) => {
    if (ok(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "دسترسی نداری.", show_alert: true }).catch(() => {});
    return false;
  };

  composer.callbackQuery(`${P}home`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await render(ctx, await homeView(), true);
  });

  composer.callbackQuery(/^adm:shop:s:(stars|jeton)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await render(ctx, await sectionView(ctx.match![1] as ShopSection), true);
  });

  composer.callbackQuery(`${P}x:legacy`, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery({ text: "این‌ها از «تنظیم قیمت ژتون» میان. با «➕ دکمه‌ی جدید» دکمه‌های خودت رو بساز.", show_alert: true });
  });

  composer.callbackQuery(/^adm:shop:t:(main|stars|jeton|wallet)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const which = ctx.match![1]!;
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "text", data: { which } });
    await ctx.reply(askText(which), { parse_mode: "HTML", reply_markup: cancelKeyboard() });
  });

  // ---- add: kind (stars section only) → colour → details
  composer.callbackQuery(/^adm:shop:a:(stars|jeton)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const section = ctx.match![1] as ShopSection;
    if (section === "jeton") return void (await pickColor(ctx, section, "url"));
    await ctx.editMessageText("نوع دکمه چیه؟", {
      reply_markup: inlineKeyboard([
        [glassButton("🔗 دکمه‌ی لینک", `${P}k:${section}:url`, "primary")],
        [glassButton("⭐ پرداخت با استارز (ژتون بده)", `${P}k:${section}:stars`, "success")],
        [glassButton("🔙 بازگشت", `${P}s:${section}`, "danger")],
      ]),
    }).catch(() => {});
  });

  async function pickColor(ctx: NavaContext, section: ShopSection, kind: "url" | "stars") {
    await ctx.editMessageText("رنگ دکمه رو انتخاب کن:", {
      reply_markup: inlineKeyboard([
        COLORS.map((c) => glassButton(COLOR_LABEL[c], `${P}n:${section}:${kind}:${c}`, c)),
        [glassButton("🔙 بازگشت", `${P}s:${section}`, "danger")],
      ]),
    }).catch(() => {});
  }

  composer.callbackQuery(/^adm:shop:k:(stars|jeton):(url|stars)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await pickColor(ctx, ctx.match![1] as ShopSection, ctx.match![2] as "url" | "stars");
  });

  composer.callbackQuery(/^adm:shop:n:(stars|jeton):(url|stars):(primary|success|danger)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const [, section, kind, color] = ctx.match as unknown as [string, ShopSection, "url" | "stars", ShopColor];
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "new", data: { section, kind, color } });
    await ctx.reply(
      kind === "url"
        ? "دو خط بفرست (با اینتر جدا کن):\n\nمتن دکمه\nلینک\n\nمثال:\nخرید از فلان‌جا\nhttps://example.com/pay"
        : "سه خط بفرست (با اینتر جدا کن):\n\nمتن دکمه\nقیمت به استارز\nتعداد ژتونی که کاربر می‌گیره\n\nمثال:\n⭐ یک استارز\n1\n100",
      { reply_markup: cancelKeyboard() },
    );
  });

  composer.callbackQuery(/^adm:shop:b:(stars|jeton):([a-f0-9]{8})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await render(ctx, await buttonView(ctx.match![1] as ShopSection, ctx.match![2]!), true);
  });

  composer.callbackQuery(/^adm:shop:c:(stars|jeton):([a-f0-9]{8})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const section = ctx.match![1] as ShopSection;
    const id = ctx.match![2]!;
    const b = (await getShopConfig())[section].buttons.find((x) => x.id === id);
    if (!b) return void (await ctx.answerCallbackQuery({ text: "پیدا نشد." }));
    await updateShopButton(section, id, { color: COLORS[(COLORS.indexOf(b.color) + 1) % 3]! });
    await ctx.answerCallbackQuery();
    await render(ctx, await buttonView(section, id), true);
  });

  composer.callbackQuery(/^adm:shop:m:(stars|jeton):([a-f0-9]{8}):(-1|1)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await moveShopButton(ctx.match![1] as ShopSection, ctx.match![2]!, Number(ctx.match![3]) as -1 | 1);
    await ctx.answerCallbackQuery();
    await render(ctx, await sectionView(ctx.match![1] as ShopSection), true);
  });

  composer.callbackQuery(/^adm:shop:d:(stars|jeton):([a-f0-9]{8})$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await removeShopButton(ctx.match![1] as ShopSection, ctx.match![2]!);
    await logAdminAction(ctx.from!.id, "shop_button_delete", `${ctx.match![1]}:${ctx.match![2]}`);
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await render(ctx, await sectionView(ctx.match![1] as ShopSection), true);
  });

  composer.callbackQuery(/^adm:shop:e:(stars|jeton):([a-f0-9]{8}):(label|url|stars)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const [, section, id, field] = ctx.match as unknown as [string, ShopSection, string, "label" | "url" | "stars"];
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "edit", data: { section, id, field } });
    await ctx.reply(
      field === "label" ? "متن جدید دکمه رو بفرست:" : field === "url" ? "لینک جدید رو بفرست (با https:// شروع بشه):" : "دو خط بفرست:\nقیمت به استارز\nتعداد ژتون",
      { reply_markup: cancelKeyboard() },
    );
  });
}

