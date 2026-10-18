import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { getDb } from "../../db/connect.js";
import { getBotSettings, setShortUsernameIds } from "../../db/models/settings.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { escapeHtml } from "../../utils/html.js";
import { isAdmin, isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { parseIdList } from "./settingsAdmin.js";
import { navagramScreen, giftsScreen } from "./navagramAdmin.js";
import { GIFT_EVENTS_HOME, openAddGift, openUserGiftsPrompt } from "./giftsAdmin.js";
import { MAX_BIO_LENGTH } from "../matching/profileEdit.js";

/**
 * Direct buttons of the «📸 نوا گرام» category of the admin keyboard + the owner-only tools that live there:
 *   👑 اکانت مالک — the owner's own account as the official «Nava» page (name, bio, photo, @Nava, blue tick + gold coin);
 *   🔢 یوزرنیم کوتاه — numeric Telegram ids that may pick a Mini App @username of any length (everybody else: 5+).
 */

export const OWN_CB = {
  open: "admin:own:open",
  setup: "admin:own:setup",
  field: "admin:own:f:", // + name|bio|photo|username
  short: "admin:short:open",
  shortAdd: "admin:short:add",
  shortDel: "admin:short:del",
  shortClear: "admin:short:clear",
};
const FLOW_OWN = "owner_profile";
const FLOW_SHORT = "short_names";
const OFFICIAL_USERNAME = "Nava";

async function users() {
  return (await getDb()).collection<any>("users");
}

async function ownerScreen() {
  const u = env.OWNER_ID !== undefined ? await (await users()).findOne({ _id: env.OWNER_ID }) : null;
  if (!u) return { text: "❌ حساب مالک پیدا نشد (OWNER_ID تنظیم نیست یا هنوز ثبت‌نام نکرده).", reply_markup: inlineKeyboard([[glassButton("↩️ بازگشت", "admin:cancel", "primary")]]) };
  const text =
    `👑 <b>اکانت مالک (صفحه‌ی رسمی نوا)</b>\n\n` +
    `نام: <b>${escapeHtml(u.nickname ?? "-")}</b> ✅🪙\n` +
    `یوزرنیم مینی‌اپ: ${u.miniUsername ? "@" + escapeHtml(u.miniUsername) : "—"}\n` +
    `بیو: ${u.bio ? escapeHtml(u.bio) : "—"}\n` +
    `عکس: ${u.profilePhotoFileId ? "دارد" : "ندارد"}\n\n` +
    `تیک آبی + سکه‌ی طلایی همیشه کنار نام این حساب نمایش داده میشه. همه‌ی کاربرها اولین باری که مینی‌اپ رو باز می‌کنن خودکار این صفحه رو دنبال می‌کنن.\n` +
    `«تنظیم خودکار» نام و یوزرنیم رو روی <b>${OFFICIAL_USERNAME}</b> میذاره.`;
  return {
    text,
    reply_markup: inlineKeyboard([
      [glassButton(`⚡ تنظیم خودکار (نام و @${OFFICIAL_USERNAME})`, OWN_CB.setup, "success")],
      [glassButton("✏️ نام", `${OWN_CB.field}name`, "primary"), glassButton("🔖 یوزرنیم", `${OWN_CB.field}username`, "primary")],
      [glassButton("📝 بیو", `${OWN_CB.field}bio`, "primary"), glassButton("🖼 عکس", `${OWN_CB.field}photo`, "primary")],
    ]),
  };
}

async function shortScreen() {
  const ids = (await getBotSettings()).shortUsernameIds ?? [];
  return {
    text:
      `🔢 <b>یوزرنیم کوتاه</b>\n\nهر یوزرنیم مینی‌اپ نوا باید حداقل ۵ کاراکتر باشه. آیدی‌های عددی تلگرامی که اینجا اضافه کنی می‌تونن یوزرنیم <b>هر طولی</b> (حتی ۱ تا ۴ کاراکتر) بذارن. مالک همیشه مجازه.\n\n` +
      `لیست فعلی (${ids.length}): ${ids.length ? ids.map((i) => `<code>${i}</code>`).join("، ") : "خالی"}`,
    reply_markup: inlineKeyboard([
      [glassButton("➕ افزودن آیدی", OWN_CB.shortAdd, "success"), glassButton("➖ حذف آیدی", OWN_CB.shortDel, "danger")],
      ...(ids.length ? [[glassButton("🗑 خالی کردن لیست", OWN_CB.shortClear, "danger")]] : []),
    ]),
  };
}

export function registerOwnerAdmin(composer: Composer<NavaContext>) {
  const reply = async (ctx: NavaContext, v: { text: string; reply_markup: any }) => ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup });

  // ---- direct keyboard buttons
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const t = ctx.message.text.trim();
    const L = ADMIN_MENU_LABELS;
    const known = [L.ngSettings, L.ngGifts, L.ngGiftAdd, L.ngEvents, L.ngUserGifts, L.ngShortNames, L.ownerProfile];
    if (!known.includes(t as any)) return next();
    await setAdminFlow(ctx.from!.id, null);
    const ownerOnly = [L.ngEvents, L.ngUserGifts, L.ngShortNames, L.ownerProfile];
    if (ownerOnly.includes(t as any) && !isOwner(ctx)) return void (await ctx.reply("این بخش فقط برای مالکه."));
    if (t === L.ngSettings) return void (await reply(ctx, await navagramScreen()));
    if (t === L.ngGifts) return void (await reply(ctx, await giftsScreen()));
    if (t === L.ngGiftAdd) return void (await openAddGift(ctx));
    if (t === L.ngEvents) return void (await reply(ctx, GIFT_EVENTS_HOME));
    if (t === L.ngUserGifts) return void (await openUserGiftsPrompt(ctx));
    if (t === L.ngShortNames) return void (await reply(ctx, await shortScreen()));
    return void (await reply(ctx, await ownerScreen()));
  });

  /* ------------------------------------------------------------ owner account */
  composer.callbackQuery(OWN_CB.open, async (ctx) => {
    if (!isOwner(ctx)) return;
    await ctx.answerCallbackQuery();
    await reply(ctx, await ownerScreen());
  });

  composer.callbackQuery(OWN_CB.setup, async (ctx) => {
    if (!isOwner(ctx) || env.OWNER_ID === undefined) return;
    const col = await users();
    const holder = await col.findOne({ miniUsernameLower: OFFICIAL_USERNAME.toLowerCase(), _id: { $ne: env.OWNER_ID } }, { projection: { _id: 1 } });
    const set: Record<string, unknown> = { nickname: OFFICIAL_USERNAME, verified: true };
    if (!holder) {
      set.miniUsername = OFFICIAL_USERNAME;
      set.miniUsernameLower = OFFICIAL_USERNAME.toLowerCase();
    }
    await col.updateOne({ _id: env.OWNER_ID }, { $set: set });
    await logAdminAction(ctx.from!.id, "owner_account_setup", holder ? "username_taken" : "ok");
    await ctx.answerCallbackQuery({ text: holder ? "نام و تیک تنظیم شد؛ ولی @Nava دست یه کاربر دیگه‌ست (از «یوزرنیم» عوضش کن)" : "انجام شد ✅", show_alert: !!holder });
    await reply(ctx, await ownerScreen());
  });

  composer.callbackQuery(new RegExp(`^${OWN_CB.field}(name|bio|photo|username)$`), async (ctx) => {
    if (!isOwner(ctx)) return;
    await ctx.answerCallbackQuery();
    const f = ctx.match![1]!;
    await setAdminFlow(ctx.from!.id, { flow: FLOW_OWN, stage: f });
    const prompt: Record<string, string> = {
      name: "نام نمایشی جدید (حداکثر ۳۲ حرف، فارسی یا انگلیسی):",
      username: "یوزرنیم مینی‌اپ جدید (انگلیسی، عدد، _ و .):",
      bio: `بیوگرافی جدید (حداکثر ${MAX_BIO_LENGTH} کاراکتر؛ برای خالی کردن «-»):`,
      photo: "عکس جدید رو بفرست:",
    };
    await ctx.reply(prompt[f]!, { reply_markup: cancelKeyboard() });
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (flow?.flow !== FLOW_OWN || flow.stage !== "photo" || env.OWNER_ID === undefined) return next();
    const fileId = ctx.message.photo[ctx.message.photo.length - 1]!.file_id;
    await (await users()).updateOne({ _id: env.OWNER_ID }, { $set: { profilePhotoFileId: fileId, profilePhotoAt: new Date() } });
    await setAdminFlow(ctx.from!.id, null);
    await logAdminAction(ctx.from!.id, "owner_account_edit", "photo");
    await reply(ctx, await ownerScreen());
  });

  /* ------------------------------------------------------------ short usernames */
  composer.callbackQuery(OWN_CB.short, async (ctx) => {
    if (!isOwner(ctx)) return;
    await ctx.answerCallbackQuery();
    await reply(ctx, await shortScreen());
  });
  composer.callbackQuery([OWN_CB.shortAdd, OWN_CB.shortDel], async (ctx) => {
    if (!isOwner(ctx)) return;
    await ctx.answerCallbackQuery();
    const add = ctx.callbackQuery.data === OWN_CB.shortAdd;
    await setAdminFlow(ctx.from!.id, { flow: FLOW_SHORT, stage: add ? "add" : "del" });
    await ctx.reply(`آیدی(های) عددی تلگرام رو بفرست تا ${add ? "اضافه" : "حذف"} بشن (با فاصله، ویرگول یا خط جدا):`, { reply_markup: cancelKeyboard() });
  });
  composer.callbackQuery(OWN_CB.shortClear, async (ctx) => {
    if (!isOwner(ctx)) return;
    await setShortUsernameIds([]);
    await logAdminAction(ctx.from!.id, "short_username_ids", "[]");
    await ctx.answerCallbackQuery({ text: "لیست خالی شد" });
    await reply(ctx, await shortScreen());
  });

  /* ------------------------------------------------------------------- text */
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || (flow.flow !== FLOW_OWN && flow.flow !== FLOW_SHORT)) return next();
    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const retry = (m: string) => ctx.reply(m, { reply_markup: cancelKeyboard() });

    if (flow.flow === FLOW_SHORT) {
      const { ids, bad } = parseIdList(text);
      if (bad.length || ids.length === 0) return void (await retry(`این موارد آیدی عددی معتبر نیستن: ${bad.length ? bad.slice(0, 5).join("، ") : "(چیزی پیدا نشد)"}\nدوباره بفرست یا لغو کن.`));
      const cur = (await getBotSettings()).shortUsernameIds ?? [];
      const next2 = flow.stage === "add" ? [...cur, ...ids] : cur.filter((i) => !ids.includes(i));
      const saved = await setShortUsernameIds(next2);
      await setAdminFlow(ctx.from!.id, null);
      await logAdminAction(ctx.from!.id, "short_username_ids", saved.join(","));
      return void (await reply(ctx, await shortScreen()));
    }

    if (env.OWNER_ID === undefined) return void (await setAdminFlow(ctx.from!.id, null));
    const col = await users();
    if (flow.stage === "name") {
      if (!text || [...text].length > 32 || /[<>]/.test(text)) return void (await retry("نام باید بین ۱ تا ۳۲ حرف باشه."));
      await col.updateOne({ _id: env.OWNER_ID }, { $set: { nickname: text } });
    } else if (flow.stage === "bio") {
      const bio = text === "-" ? "" : text;
      if ([...bio].length > MAX_BIO_LENGTH) return void (await retry(`بیو حداکثر ${MAX_BIO_LENGTH} کاراکتر باشه.`));
      await col.updateOne({ _id: env.OWNER_ID }, { $set: { bio } });
    } else if (flow.stage === "username") {
      const { setMiniUsername } = await import("../../services/miniappSocial.js");
      const me = await col.findOne({ _id: env.OWNER_ID });
      if (!me) return void (await setAdminFlow(ctx.from!.id, null));
      try {
        await setMiniUsername(me, text, true);
      } catch (err: any) {
        const why: Record<string, string> = { taken: "این یوزرنیم قبلاً انتخاب شده.", bad_chars: "فقط حروف انگلیسی، عدد، _ و . مجازه.", bad_dots: "نقطه نباید اول/آخر یا پشت‌سرهم باشه.", too_long: "حداکثر ۲۴ کاراکتر.", too_short: "خیلی کوتاهه.", reserved: "این یوزرنیم رزرو شده." };
        return void (await retry(why[err?.code] ?? "نامعتبر. دوباره بفرست یا لغو کن."));
      }
    } else {
      return void (await retry("باید عکس بفرستی."));
    }
    await setAdminFlow(ctx.from!.id, null);
    await logAdminAction(ctx.from!.id, "owner_account_edit", flow.stage);
    await reply(ctx, await ownerScreen());
  });
}
