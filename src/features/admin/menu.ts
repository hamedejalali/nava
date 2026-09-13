import { glassReplyButton, replyKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { isOwner } from "./constants.js";
import type { NavaContext } from "../../bot-context.js";

/** Plain-text labels for the admin Reply Keyboard — Reply Keyboard buttons
 *  have no callback_data, so a tap arrives as a normal text message with
 *  this exact text; handlers match on it. Keep these unique and stable. */
export const ADMIN_MENU_LABELS = {
  broadcast: "📢 پیام همگانی",
  verify: "☑️ وریفای / تیک تأیید",
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
  close: "❌ بستن پنل",
} as const;

/** Items only the owner should see/use (dynamic admin management, and
 *  granting user levels — both security/reputation-sensitive). */
const OWNER_ONLY: string[] = [ADMIN_MENU_LABELS.moderators, ADMIN_MENU_LABELS.level];

export function buildAdminReplyKeyboard(ctx: NavaContext) {
  const owner = isOwner(ctx);
  const entries: Array<{ label: string; icon?: string }> = [
    { label: ADMIN_MENU_LABELS.broadcast, icon: buttonIcon("BROADCAST") },
    { label: ADMIN_MENU_LABELS.verify, icon: buttonIcon("VERIFIED_BADGE") },
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
  ].filter((e) => owner || !OWNER_ONLY.includes(e.label));

  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    const chunk = entries.slice(i, i + 2);
    rows.push(chunk.map((e, j) => glassReplyButton(e.label, (i + j) % 2 === 0 ? "primary" : "success", e.icon)));
  }
  rows.push([glassReplyButton(ADMIN_MENU_LABELS.close, "danger")]);

  return replyKeyboard(rows);
}
