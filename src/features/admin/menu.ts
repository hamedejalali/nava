import { glassReplyButton, replyKeyboard, iconIdOnly, type IconInput } from "../../ui/keyboard.js";
import { VERSION_BUTTON_LABEL } from "../../config/version.js";
import { buttonIcon } from "../../config/emojis.js";
import type { Composer } from "grammy";
import { isOwner, isAdmin } from "./constants.js";
import type { NavaContext } from "../../bot-context.js";
import { setAdminFlow } from "./flowState.js";

/** Plain-text labels for the admin Reply Keyboard — Reply Keyboard buttons
 *  have no callback_data, so a tap arrives as a normal text message with
 *  this exact text; handlers match on it. Keep these unique and stable. */
export const ADMIN_MENU_LABELS = {
  broadcast: "📢 پیام همگانی",
  verify: "☑️ وریفای / تیک تأیید",
  verifiedUsers: "✅ کاربران وریفای",
  userList: "👥 لیست کاربران",
  ban: "🚫 بن کاربر",
  unban: "🔓 آن‌بن کاربر",
  reports: "⚠️ گزارش‌های کاربران",
  search: "🔎 جستجوی کاربر",
  fullProfile: "👤 پروفایل کامل کاربر",
  relic: "🪙 مدیریت Relic",
  level: "⭐ مدیریت Level",
  moderators: "🛡️ مدیریت Moderator / Admin",
  stats: "📊 آمار ربات",
  activityLog: "🔐 لاگ فعالیت ادمین‌ها",
  settings: "⚙️ تنظیمات ربات",
  guidesAndChannels: "🛠 راهنما / کانال جوین / پشتیبانی",
  resetUser: "♻️ ریست اطلاعات کاربر",
  pricing: "💳 تنظیم قیمت رلیک",
  reactionGate: "🎯 تنظیم گیت ری‌اکشن",
  exportUsers: "📤 خروجی اکسل کاربران",
  importUsers: "📥 ورودی اکسل (بازیابی)",
  close: "❌ بستن پنل",
} as const;

/** Silently swallows taps on the version button (and removes the echoed
 *  message from the chat so literally nothing visible happens). Must be
 *  registered before any generic admin text handler. */
export function registerAdminVersionButton(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (ctx.message.text.trim() !== VERSION_BUTTON_LABEL) return next();
    if (!isAdmin(ctx)) return next();
    await ctx.deleteMessage().catch(() => {});
  });
}

/** Items only the owner should see/use (dynamic admin management, granting
 *  user levels, and fully wiping a user's profile — all irreversible or
 *  security-sensitive enough to keep away from regular admins). */
const OWNER_ONLY: string[] = [
  ADMIN_MENU_LABELS.moderators,
  ADMIN_MENU_LABELS.level,
  ADMIN_MENU_LABELS.resetUser,
  ADMIN_MENU_LABELS.exportUsers,
  ADMIN_MENU_LABELS.importUsers,
];

/** Admin panel categories (v1.17): the main keyboard shows ONE button per group instead of ~20 loose buttons.
 *  A category opens a sub-keyboard made of the very same labels as before, so every existing handler keeps working. */
export const ADMIN_CATEGORY_LABELS = {
  users: "👥 کاربر ها",
  messages: "📢 پیام و گزارش",
  economy: "🪙 اقتصاد رلیک",
  staff: "🛡️ مدیریت و لاگ",
  settings: "⚙️ تنظیمات و ابزار",
  data: "💾 داده‌ها",
  back: "↩️ بازگشت به پنل",
} as const;

type CategoryId = Exclude<keyof typeof ADMIN_CATEGORY_LABELS, "back">;

const ADMIN_CATEGORIES: Record<CategoryId, Array<{ label: string; icon?: () => IconInput }>> = {
  users: [
    { label: ADMIN_MENU_LABELS.userList, icon: () => buttonIcon("USERS") },
    { label: ADMIN_MENU_LABELS.search, icon: () => buttonIcon("SEARCH") },
    { label: ADMIN_MENU_LABELS.fullProfile, icon: () => buttonIcon("PROFILE") },
    { label: ADMIN_MENU_LABELS.ban, icon: () => buttonIcon("BAN") },
    { label: ADMIN_MENU_LABELS.unban, icon: () => buttonIcon("UNBAN") },
    { label: ADMIN_MENU_LABELS.verify, icon: () => buttonIcon("VERIFIED_BADGE") },
    { label: ADMIN_MENU_LABELS.verifiedUsers, icon: () => buttonIcon("VERIFIED_BADGE") },
    { label: ADMIN_MENU_LABELS.resetUser, icon: () => buttonIcon("RESET_USER") },
  ],
  messages: [{ label: ADMIN_MENU_LABELS.broadcast, icon: () => buttonIcon("BROADCAST") }, { label: ADMIN_MENU_LABELS.reports }],
  economy: [
    { label: ADMIN_MENU_LABELS.relic, icon: () => buttonIcon("CROWN") },
    { label: ADMIN_MENU_LABELS.pricing },
    { label: ADMIN_MENU_LABELS.level, icon: () => buttonIcon("LEVEL_LEGEND") },
  ],
  staff: [{ label: ADMIN_MENU_LABELS.moderators }, { label: ADMIN_MENU_LABELS.activityLog, icon: () => buttonIcon("LOG") }],
  settings: [
    { label: ADMIN_MENU_LABELS.settings, icon: () => buttonIcon("SETTINGS") },
    { label: ADMIN_MENU_LABELS.guidesAndChannels },
    { label: ADMIN_MENU_LABELS.reactionGate },
  ],
  data: [{ label: ADMIN_MENU_LABELS.exportUsers }, { label: ADMIN_MENU_LABELS.importUsers }],
};

function visibleEntries(ctx: NavaContext, id: CategoryId) {
  const owner = isOwner(ctx);
  return ADMIN_CATEGORIES[id].filter((e) => owner || !OWNER_ONLY.includes(e.label));
}

function pairRows(items: Array<{ label: string; icon?: IconInput }>) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2).map((e, j) => glassReplyButton(e.label, (i + j) % 2 === 0 ? "primary" : "success", iconIdOnly(e.icon))));
  }
  return rows;
}

export function buildAdminReplyKeyboard(ctx: NavaContext) {
  const cats = (Object.keys(ADMIN_CATEGORIES) as CategoryId[]).filter((id) => visibleEntries(ctx, id).length > 0);
  const items: Array<{ label: string; icon?: IconInput }> = cats.map((id) => ({ label: ADMIN_CATEGORY_LABELS[id] }));
  items.push({ label: ADMIN_MENU_LABELS.stats, icon: buttonIcon("STATS") });
  const rows = pairRows(items);
  // Version button: does nothing when tapped (see registerAdminVersionButton)
  // — it only exists to show which build is deployed.
  rows.push([glassReplyButton(VERSION_BUTTON_LABEL, "primary")]);
  rows.push([glassReplyButton(ADMIN_MENU_LABELS.close, "danger")]);
  return replyKeyboard(rows);
}

export function buildAdminCategoryKeyboard(ctx: NavaContext, id: CategoryId) {
  const rows = pairRows(visibleEntries(ctx, id).map((e) => ({ label: e.label, icon: e.icon?.() })));
  rows.push([glassReplyButton(ADMIN_CATEGORY_LABELS.back, "danger")]);
  return replyKeyboard(rows);
}

/** Opens a category (or goes back to the main panel). A half-finished text flow is dropped, like every other panel button does. */
export function registerAdminCategories(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const text = ctx.message.text.trim();
    if (text === ADMIN_CATEGORY_LABELS.back) {
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("پنل مدیریت 👇", { reply_markup: buildAdminReplyKeyboard(ctx) });
      return;
    }
    const id = (Object.keys(ADMIN_CATEGORIES) as CategoryId[]).find((k) => ADMIN_CATEGORY_LABELS[k] === text);
    if (!id || visibleEntries(ctx, id).length === 0) return next();
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply(`${text} — یکی رو انتخاب کن 👇`, { reply_markup: buildAdminCategoryKeyboard(ctx, id) });
  });
}
