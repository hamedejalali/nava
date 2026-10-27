import type { Composer } from "grammy";
import { cancelKeyboard } from "../common/userFlows.js";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getContent, setContent, type ContentKey } from "../../db/models/content.js";
import { startEdit, getEdit, clearEdit } from "../../db/models/adminSession.js";
import { fa } from "../../i18n/locales/fa.js";
import { ADMIN_CALLBACKS, isAdmin } from "./constants.js";
import { isFlowCancelSignal } from "./flowState.js";
import { defaultInviteMessageTemplate } from "../menu/inviteFriends.js";
import { DEFAULT_MAINTENANCE_TEXT } from "../../services/maintenance.js";

// Default for the general "Guide" content (shown from the main menu's Guide
// button in a future prompt). Exact wording was not specified by the
// project owner, so this is a placeholder functional default — freely
// editable by the admin at any time via "متن راهنما".
const DEFAULT_GUIDE_TEXT = "به مویا خوش اومدی! هر سوالی داشتی از همینجا یا با ادمین در میون بذار.";

// LOCKED default (Feature 05) — "هایپر گپ" replaced with "مویا" per owner
// request (Feature 05 of the second feature batch). Admin may edit it
// afterward via the same "ویرایش راهنما ها" workflow regardless.
import { DEFAULT_PINNED_PROMO } from "../../config/defaultTexts.js";

// LOCKED default (Feature "RULES") — "هایپر گپ" replaced with "مویا" per
// owner request (Feature 05 of the second feature batch).
export const DEFAULT_RULES =
  "ربات چت ناشناس مویا:\n" +
  "🚦🚧 قوانين استفاده از ربات مویا 🚧🚦\n\n" +
  "موارد زیر باعث مسدود شدن دائمی کاربر خواهد شد.\n\n" +
  "1️⃣ تبلیغات سایت ها ربات ها و کانال ها\n\n" +
  "2️⃣ ارسال هرگونه محتوای غیر اخلاقی\n\n" +
  "3️⃣ ایجاد مزاحمت برای کاربران\n\n" +
  "4️⃣ پخش شماره موبایل یا اطلاعات شخصی دیگران\n\n" +
  "5️⃣ محتوای غیر اخلاقی و یا توهین آمیز در پروفایل مویا\n\n" +
  "6️⃣ ثبت جنسیت اشتباه در پروفایل\n\n" +
  "7️⃣ تهدید و جا زدن خود بعنوان مدیر ربات یا پلیس فتا !\n\n" +
  "برای گزارش عدم رعایت قوانین می توانید با لمس 《 🚫 گزارش کاربر 》 در پروفایل، کاربر را گزارش کنید.\n\n" +
  "👈درصورت گزارش صحیح کاربر متخلف 💰 5 ژتون بعنوان هدیه دریافت میکنید.\n\n" +
  "🔸 - ‏ راهنما : /help";

const LABELS: Record<ContentKey, string> = {
  guideText: "متن راهنما",
  guide1: "راهنمای شماره یک",
  pinnedPromo: "پیام پین",
  rules: "قوانین",
  supportId: "آیدی پشتیبانی",
  inviteMessage: "متن دعوت دوستان",
  maintenanceText: "متن خاموشی ربات",
};

function defaultFor(key: ContentKey): string {
  if (key === "guide1") return fa.onboarding.guide1!;
  if (key === "pinnedPromo") return DEFAULT_PINNED_PROMO;
  if (key === "rules") return DEFAULT_RULES;
  if (key === "supportId") return "";
  if (key === "inviteMessage") return defaultInviteMessageTemplate();
  if (key === "maintenanceText") return DEFAULT_MAINTENANCE_TEXT;
  return DEFAULT_GUIDE_TEXT;
}

export function registerAdminGuides(composer: Composer<NavaContext>) {
  // the list of editable texts is the «📝 متن‌ها» screen (panel.ts); the old callback still opens it
  composer.callbackQuery(ADMIN_CALLBACKS.openGuideMenu, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const { textsMenu } = await import("./panel.js");
    await ctx.reply("📝 کدوم متن رو ویرایش می‌کنی؟", { reply_markup: textsMenu() });
  });

  const beginEdit = async (ctx: NavaContext, key: ContentKey) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();

    const current = await getContent(key, defaultFor(key));
    await ctx.reply(current ? `متن فعلی «${LABELS[key]}»:\n\n${current}` : `«${LABELS[key]}» هنوز تنظیم نشده.`);

    const sent = await ctx.reply("متن جدید رو بفرست:", {
      reply_markup: cancelKeyboard(),
    });
    await startEdit(ctx.from!.id, key, sent.message_id);
  };

  composer.callbackQuery(ADMIN_CALLBACKS.editGuideText, (ctx) => beginEdit(ctx, "guideText"));
  composer.callbackQuery(ADMIN_CALLBACKS.editGuide1, (ctx) => beginEdit(ctx, "guide1"));
  composer.callbackQuery(ADMIN_CALLBACKS.editPinnedPromo, (ctx) => beginEdit(ctx, "pinnedPromo"));
  composer.callbackQuery(ADMIN_CALLBACKS.editRules, (ctx) => beginEdit(ctx, "rules"));
  composer.callbackQuery(ADMIN_CALLBACKS.editSupportId, (ctx) => beginEdit(ctx, "supportId"));
  composer.callbackQuery(ADMIN_CALLBACKS.editInviteMessage, (ctx) => beginEdit(ctx, "inviteMessage"));
  composer.callbackQuery(ADMIN_CALLBACKS.editMaintenanceText, (ctx) => beginEdit(ctx, "maintenanceText"));

  composer.callbackQuery(ADMIN_CALLBACKS.cancelEdit, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await clearEdit(ctx.from!.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("لغو شد.").catch(() => {});
  });

  // Must run before the generic onboarding/menu text handlers so an admin's
  // reply while editing is never misread as onboarding input.
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();

    const session = await getEdit(ctx.from!.id);
    if (!session) return next();

    const newText = ctx.message.text.trim();

    if (isFlowCancelSignal(newText)) {
      await clearEdit(ctx.from!.id);
      if (newText.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    if (!newText) {
      await ctx.reply("متن نمی‌تونه خالی باشه. دوباره بفرست یا لغو کن.");
      return;
    }

    await setContent(session.editingKey, newText, ctx.from!.id);
    await clearEdit(ctx.from!.id);
    await ctx.reply(`✅ «${LABELS[session.editingKey]}» ذخیره شد.`);
  });
}
