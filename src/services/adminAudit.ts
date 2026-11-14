import { botApi } from "./miniapp.js";
import { getLogChatId, ROUTE_PURPOSES } from "./channelRouting.js";
import { getDb } from "../db/connect.js";
import { PERMS } from "../features/admin/permissions.js";

/**
 * Admin activity log — one readable Persian description per action (v1.28.1).
 * `describeAdminAction` is used by BOTH the log channel/DM message and the in-panel «لاگ فعالیت» screen, so they always agree.
 * Raw keys (maintenance_allow_add …) are never shown to people any more; an action nobody described yet is still shown
 * with a clear «اقدام ثبت‌نشده» line, never as a bare code.
 */

type Kind = "user" | "users" | "text" | "bool" | "none";
interface Spec {
  /** short action name, past tense: what the admin did */
  title: string;
  /** what the details field holds: it is turned into the «مورد» line */
  target?: Kind;
  /** label of the «مورد» line */
  label?: string;
  /** extra rendering of the parts after the first colon */
  rest?: (parts: string[]) => string;
}

const ONOFF = (v: string) => (v === "true" || v === "on" ? "روشن" : "خاموش");
const DEST: Record<string, string> = { mgmt: "کانال مدیریت", dm: "پیام خصوصی به ادمین‌ها", off: "غیرفعال" };

export const ADMIN_ACTIONS: Record<string, Spec> = {
  // — v1.31.0 «طراحی داخلی ربات»
  text_set: { title: "متنی را ویرایش کرد", target: "text", label: "متن" },
  text_reset: { title: "متنی را به پیش‌فرض برگرداند", target: "text", label: "متن" },
  button_label_set: { title: "نام یک دکمه را تغییر داد", target: "text", label: "دکمه" },
  button_style_set: { title: "رنگ یک دکمه را تغییر داد", target: "text", label: "دکمه" },
  button_hide_toggle: { title: "نمایش یک دکمه را تغییر داد", target: "text", label: "دکمه" },
  button_reset: { title: "یک دکمه را به حالت اول برگرداند", target: "text", label: "دکمه" },
  button_add: { title: "دکمه‌ی جدید ساخت", target: "text", label: "دکمه" },
  button_delete: { title: "یک دکمه را حذف کرد", target: "text", label: "دکمه" },
  button_reply_set: { title: "پیام یک دکمه را تغییر داد", target: "text", label: "دکمه" },
  // — users / money
  jeton_send: { title: "ژتون ارسال کرد", target: "user", label: "گیرنده", rest: (p) => `مقدار: ${p[1]} ژتون` },
  jeton_deduct: { title: "ژتون کسر کرد", target: "user", label: "از کاربر", rest: (p) => `مقدار: ${p[1]} ژتون` },
  jeton_mass_send: { title: "ژتون گروهی ارسال کرد", target: "text", label: "گروه گیرنده", rest: (p) => `به ازای هر نفر: ${p[1]} ژتون — دریافت‌کننده: ${p[2]} نفر` },
  set_level: { title: "سطح کاربر را تغییر داد", target: "text" },
  ban_user: { title: "کاربر را بن کرد", target: "user", label: "کاربر" },
  unban_user: { title: "بن کاربر را برداشت", target: "user", label: "کاربر" },
  toggle_verify: { title: "وضعیت وریفای کاربر را تغییر داد", target: "user", label: "کاربر" },
  verify_approve: { title: "درخواست وریفای را تأیید کرد", target: "user", label: "کاربر" },
  verify_reject: { title: "درخواست وریفای را رد کرد", target: "user", label: "کاربر" },
  reset_user: { title: "اطلاعات کاربر را ریست کرد", target: "user", label: "کاربر" },
  set_badges: { title: "بج‌های کاربر را تغییر داد", target: "user", label: "کاربر", rest: (p) => `بج‌ها: ${p[1] ? p[1] : "هیچ"}` },
  miniapp_photo_remove: { title: "عکس پروفایل کاربر را از مویاگرام برداشت", target: "user", label: "کاربر" },
  // — admins
  grant_admin: { title: "ادمین جدید اضافه کرد", target: "user", label: "ادمین جدید" },
  revoke_admin: { title: "ادمین را برداشت", target: "user", label: "ادمین" },
  admin_perms: {
    title: "دسترسی یک ادمین را تغییر داد", target: "user", label: "ادمین",
    rest: (p) => { const [k, v] = (p[1] ?? "").split("="); return `دسترسی «${(PERMS as Record<string, string>)[k ?? ""] ?? k}» ${v === "on" ? "روشن شد ✅" : "خاموش شد ⛔️"}`; },
  },
  // — reports
  review_report: { title: "یک گزارش کاربر را بررسی کرد", target: "text", label: "شناسه‌ی گزارش" },
  report_approve: { title: "گزارش کاربر را تأیید کرد", target: "text", label: "شناسه‌ی گزارش" },
  report_reject: { title: "گزارش کاربر را رد کرد", target: "text", label: "شناسه‌ی گزارش" },
  post_report_ignore: { title: "گزارش یک پست را نادیده گرفت", target: "text", label: "شناسه‌ی پست" },
  post_report_delete: { title: "پست گزارش‌شده را حذف کرد", target: "text", label: "شناسه‌ی پست", rest: (p) => `صاحب پست: ${p[1]}` },
  post_report_delete_ban: { title: "پست گزارش‌شده را حذف و صاحبش را بن کرد", target: "text", label: "شناسه‌ی پست", rest: (p) => `صاحب پست: ${p[1]}` },
  miniapp_post_delete: { title: "یک پست مویاگرام را حذف کرد", target: "text", label: "شناسه‌ی پست", rest: (p) => `صاحب پست: ${p[1]}` },
  miniapp_story_delete: { title: "یک استوری مویاگرام را حذف کرد", target: "text", label: "شناسه‌ی استوری", rest: (p) => `صاحب استوری: ${p[1]}` },
  // — bot on/off
  toggle_maintenance: { title: "حالت خاموشی ربات را تغییر داد", target: "bool", rest: (p) => (p[0] === "true" ? "ربات برای کاربران عادی خاموش شد ⛔️" : "ربات دوباره روشن شد ✅") },
  maintenance_allow_add: { title: "به لیست مجازهای خاموشی اضافه کرد (در خاموشی هم ربات برایشان کار می‌کند)", target: "users", label: "اضافه‌شده‌ها" },
  maintenance_allow_remove: { title: "از لیست مجازهای خاموشی حذف کرد", target: "user", label: "حذف‌شده" },
  // — settings
  var_set: { title: "یک تنظیم/متغیر را تغییر داد", target: "text", label: "نام تنظیم" },
  var_clear: { title: "یک تنظیم/متغیر را پاک کرد", target: "text", label: "نام تنظیم" },
  vars_migrate: { title: "تنظیمات را از env به پنل منتقل کرد", target: "text", label: "تعداد" },
  emoji_set: { title: "ایموجی را تغییر داد", target: "text", label: "کلید" },
  premium_emoji_toggle: { title: "ایموجی پریمیوم را تغییر داد", target: "bool", rest: (p) => `الان ${ONOFF(p[0] ?? "")} است` },
  wallet_toggle: { title: "اتصال ولت را تغییر داد", target: "bool", rest: (p) => `الان ${ONOFF(p[0] ?? "")} است` },
  route_set: { title: "مسیر ارسال یک نوع اعلان را تغییر داد", target: "none", rest: (p) => `${(ROUTE_PURPOSES as Record<string, string>)[p[0] ?? ""] ?? p[0]} ← ${DEST[p[1] ?? ""] ?? p[1]}` },
  backup_channel_set: { title: "کانال بکاپ را تنظیم کرد", target: "text", label: "آیدی کانال" },
  backup_channel_clear: { title: "کانال بکاپ را برداشت" },
  mgmt_channel_set: { title: "کانال مدیریت را تنظیم کرد", target: "text", label: "آیدی کانال" },
  mgmt_channel_clear: { title: "کانال مدیریت را برداشت" },
  broadcast_created: { title: "پیام همگانی ساخت و شروع کرد", target: "text", label: "شناسه‌ی ارسال" },
  short_username_ids: { title: "لیست یوزرنیم‌های کوتاه مجاز را تغییر داد", target: "users", label: "آیدی‌ها" },
  owner_account_setup: { title: "اکانت مویاگرامِ مالک را راه‌اندازی کرد", target: "none", rest: (p) => (p[0] === "ok" ? "موفق" : "یوزرنیم قبلاً گرفته شده بود") },
  owner_account_edit: { title: "اکانت مویاگرامِ مالک را ویرایش کرد", target: "text", label: "بخش" },
  official_create: { title: "حساب رسمی (حقوقی) ساخت", target: "text", label: "حساب" },
  // — default members
  seed_create: { title: "ممبر پیش‌فرض ساخت", target: "text", label: "شناسه" },
  seed_edit: { title: "ممبر پیش‌فرض را ویرایش کرد", target: "text", label: "ممبر", rest: (p) => `بخش‌ها: ${p[1]}` },
  seed_delete: { title: "ممبر پیش‌فرض را حذف کرد", target: "text", label: "شناسه" },
  seed_verify: { title: "وریفای ممبر پیش‌فرض را تغییر داد", target: "text", label: "ممبر", rest: (p) => (p[1] === "true" ? "وریفای شد" : "وریفای برداشته شد") },
  seed_hidden: { title: "نمایش ممبرهای پیش‌فرض را تغییر داد", target: "bool", rest: (p) => (p[0] === "true" ? "پنهان شدند" : "دوباره دیده می‌شوند") },
  seed_chat: { title: "چت ممبرهای پیش‌فرض را تغییر داد", target: "bool", rest: (p) => (p[0] === "true" ? "فعال شد" : "غیرفعال شد") },
  seed_batch: { title: "چند ممبر پیش‌فرض را یک‌جا ساخت", target: "text", label: "تعداد" },
  // — gifts & moyagram
  navagram_gift_add: { title: "هدیه‌ی جدید به مویاگرام اضافه کرد", target: "text", label: "هدیه", rest: (p) => `قیمت: ${p[1]} ژتون` },
  navagram_gift_import: { title: "هدیه‌ها را از فایل وارد کرد", target: "text", label: "ساخته‌شده/کل" },
  navagram_gift_toggle: { title: "فعال/غیرفعال بودن یک هدیه را تغییر داد", target: "text", label: "هدیه" },
  navagram_gift_unique: { title: "یکتا بودن یک هدیه را تغییر داد", target: "text", label: "هدیه", rest: (p) => (p[1] === "true" ? "یکتا شد" : "یکتا نیست") },
  navagram_gift_remove: { title: "یک هدیه را حذف کرد", target: "text", label: "هدیه" },
  navagram_gift_edit: { title: "یک هدیه را ویرایش کرد", target: "text", label: "هدیه", rest: (p) => `بخش: ${p[1]}` },
  navagram_gift_price: { title: "قیمت یک هدیه را تغییر داد", target: "text", label: "هدیه", rest: (p) => `قیمت جدید: ${p[1]} ژتون` },
  navagram_channel_set: { title: "کانال کپی پست‌های مویاگرام را تنظیم کرد", target: "text", label: "آیدی کانال" },
  navagram_channel_clear: { title: "کانال کپی پست‌های مویاگرام را برداشت" },
  navagram_channel_copy: { title: "کپی پست‌ها در کانال را تغییر داد", target: "bool", rest: (p) => `الان ${ONOFF(p[0] ?? "")} است` },
  navagram_events_channel_set: { title: "کانال رویدادهای هدیه را تنظیم کرد", target: "text", label: "آیدی کانال" },
  navagram_events_channel_clear: { title: "کانال رویدادهای هدیه را برداشت" },
  gift_delete: { title: "هدیه‌ی یک کاربر را حذف کرد", target: "user", label: "صاحب هدیه", rest: (p) => `شناسه‌ی هدیه: ${p[1]}` },
  gift_take: { title: "هدیه را از یک کاربر پس گرفت", target: "user", label: "از کاربر", rest: (p) => `شناسه‌ی هدیه: ${p[1]}` },
  gift_event_create: { title: "رویداد هدیه (قرعه‌کشی/حراج) ساخت", target: "text", label: "شناسه‌ی رویداد", rest: (p) => `نوع: ${p[1]}` },
  gift_event_end: { title: "رویداد هدیه را پایان داد", target: "text", label: "شناسه‌ی رویداد", rest: (p) => `نتیجه: ${p[1]}` },
  gift_event_cancel: { title: "رویداد هدیه را لغو کرد", target: "text", label: "شناسه‌ی رویداد", rest: (p) => `نتیجه: ${p[1]}` },
  // — shop
  shop_text: { title: "متن فروشگاه را ویرایش کرد", target: "text", label: "بخش" },
  shop_button_add: { title: "دکمه‌ی فروشگاه اضافه کرد", target: "text", label: "بخش", rest: (p) => `متن: ${p[1]}` },
  shop_button_edit: { title: "دکمه‌ی فروشگاه را ویرایش کرد", target: "text", label: "بخش", rest: (p) => `شناسه: ${p[1]} — فیلد: ${p[2]}` },
  shop_button_delete: { title: "دکمه‌ی فروشگاه را حذف کرد", target: "text", label: "بخش", rest: (p) => `شناسه: ${p[1]}` },
};

async function nameOf(id: string): Promise<string> {
  const n = id.trim();
  if (!/^\d+$/.test(n)) return n;
  try {
    const u = await (await getDb()).collection<any>("users").findOne({ _id: Number(n) as any }, { projection: { nickname: 1, anonId: 1, username: 1 } });
    if (!u) return `کاربر ناشناس (${n})`;
    return `${u.nickname ?? "بدون نام"} — ${u.anonId ?? "-"}${u.username ? ` — @${u.username}` : ""} — ${n}`;
  } catch {
    return n;
  }
}

/** The multi-line Persian description of one admin action (no time line; callers add it). */
export async function describeAdminAction(adminId: number, action: string, details?: string): Promise<string> {
  const who = await nameOf(String(adminId));
  const spec = ADMIN_ACTIONS[action];
  if (!spec) return `👤 ادمین: ${who}\n📌 کار: اقدام ثبت‌نشده (${action})${details ? `\nℹ️ جزئیات: ${details}` : ""}`;
  const lines = [`👤 ادمین: ${who}`, `📌 کار: ${spec.title}`];
  const raw = details ?? "";
  // «123 (report x)» style: a leading number may carry a note after a space
  const parts = raw.split(":").map((s) => s.trim());
  const head = (parts[0] ?? "").split(" ")[0] ?? "";
  const note = (parts[0] ?? "").includes(" ") ? (parts[0] ?? "").slice(head.length).trim() : "";
  switch (spec.target) {
    case "user": lines.push(`🎯 ${spec.label ?? "کاربر"}: ${await nameOf(head)}`); break;
    case "users": {
      const ids = raw.split(",").map((s) => s.trim()).filter((s) => s && s !== "[]");
      const names = await Promise.all(ids.map((i) => nameOf(i)));
      lines.push(names.length ? `🎯 ${spec.label ?? "کاربران"}:\n${names.map((n) => `   • ${n}`).join("\n")}` : `🎯 ${spec.label ?? "کاربران"}: لیست خالی شد`);
      break;
    }
    case "text": if (head) lines.push(`🎯 ${spec.label ?? "مورد"}: ${head}`); break;
    default: break;
  }
  if (note) lines.push(`ℹ️ ${note.replace(/^\(|\)$/g, "")}`);
  const extra = spec.rest?.(parts);
  if (extra) lines.push(`ℹ️ ${extra}`);
  return lines.join("\n");
}

function tehranTime(d = new Date()): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString();
  }
}
export { tehranTime };

/** Human message for the admin-log channel (route «adminLog»). Best effort: a failure never blocks the admin's action. */
export async function announceAdminAction(adminId: number, action: string, details?: string): Promise<void> {
  try {
    const chat = await getLogChatId("adminLog");
    if (chat === undefined) return;
    const body = await describeAdminAction(adminId, action, details);
    await botApi().sendMessage(chat, `🔐 لاگ ادمین\n\n${body}\n🕒 ${tehranTime()}`);
  } catch {
    /* never blocks the action */
  }
}
