import { glassReplyButton, replyKeyboard, iconIdOnly, type IconInput } from "../../ui/keyboard.js";
import { VERSION_BUTTON_LABEL } from "../../config/version.js";
import { buttonIcon } from "../../config/emojis.js";
import type { Composer } from "grammy";
import { isOwner, isAdmin } from "./constants.js";
import type { NavaContext } from "../../bot-context.js";

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
const OWNER_ONLY: string[] = [ADMIN_MENU_LABELS.moderators, ADMIN_MENU_LABELS.level, ADMIN_MENU_LABELS.resetUser];

export function buildAdminReplyKeyboard(ctx: NavaContext) {
  const owner = isOwner(ctx);
  const entries: Array<{ label: string; icon?: IconInput }> = [
    { label: ADMIN_MENU_LABELS.broadcast, icon: buttonIcon("BROADCAST") },
    { label: ADMIN_MENU_LABELS.verify, icon: buttonIcon("VERIFIED_BADGE") },
    { label: ADMIN_MENU_LABELS.verifiedUsers, icon: buttonIcon("VERIFIED_BADGE") },
    { label: ADMIN_MENU_LABELS.userList, icon: buttonIcon("USERS") },
    { label: ADMIN_MENU_LABELS.ban, icon: buttonIcon("BAN") },
    { label: ADMIN_MENU_LABELS.unban, icon: buttonIcon("UNBAN") },
    { label: ADMIN_MENU_LABELS.reports },
    { label: ADMIN_MENU_LABELS.search, icon: buttonIcon("SEARCH") },
    { label: ADMIN_MENU_LABELS.fullProfile, icon: buttonIcon("PROFILE") },
    { label: ADMIN_MENU_LABELS.relic, icon: buttonIcon("CROWN") },
    { label: ADMIN_MENU_LABELS.level, icon: buttonIcon("LEVEL_LEGEND") },
    { label: ADMIN_MENU_LABELS.moderators },
    { label: ADMIN_MENU_LABELS.stats, icon: buttonIcon("STATS") },
    { label: ADMIN_MENU_LABELS.activityLog, icon: buttonIcon("LOG") },
    { label: ADMIN_MENU_LABELS.settings, icon: buttonIcon("SETTINGS") },
    { label: ADMIN_MENU_LABELS.guidesAndChannels },
    { label: ADMIN_MENU_LABELS.resetUser, icon: buttonIcon("RESET_USER") },
    { label: ADMIN_MENU_LABELS.pricing },
  ].filter((e) => owner || !OWNER_ONLY.includes(e.label));

  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    const chunk = entries.slice(i, i + 2);
    rows.push(chunk.map((e, j) => glassReplyButton(e.label, (i + j) % 2 === 0 ? "primary" : "success", iconIdOnly(e.icon))));
  }
  // Version button: does nothing when tapped (see registerAdminVersionButton)
  // — it only exists to show which build is deployed.
  rows.push([glassReplyButton(VERSION_BUTTON_LABEL, "primary")]);
  rows.push([glassReplyButton(ADMIN_MENU_LABELS.close, "danger")]);

  return replyKeyboard(rows);
}
