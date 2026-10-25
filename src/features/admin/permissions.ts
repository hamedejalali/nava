import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { isOwner } from "./constants.js";

/**
 * Per-admin permissions (v1.26). The OWNER always has everything. Every other admin has a switch per feature, set by the owner
 * when adding the admin (and editable later). `adminPerms` lives on the user document; a missing key falls back to DEFAULT_PERMS,
 * so admins that existed before this version keep exactly the access they had.
 */
export const PERMS = {
  broadcast: "📢 پیام همگانی",
  verify: "☑️ وریفای و کاربران وریفای",
  badges: "🏅 بج‌ها",
  users: "👥 لیست / جستجو / پروفایل کاربران",
  ban: "🚫 بن و آن‌بن",
  reports: "⚠️ گزارش‌های کاربران",
  jeton: "🪙 ارسال و کسر ژتون",
  pricing: "💳 قیمت‌ها و منوی خرید",
  reactionGate: "🎯 گیت ری‌اکشن",
  guides: "🛠 راهنما / کانال جوین / پشتیبانی",
  settings: "⚙️ تنظیمات ربات (خاموشی)",
  stats: "📊 آمار ربات",
  activityLog: "🔐 لاگ فعالیت ادمین‌ها",
  seeds: "🎭 ممبرهای پیش‌فرض",
  nava: "📸 نوا گرام (هدیه‌ها، کانال‌ها)",
  resetUser: "♻️ ریست اطلاعات کاربر",
  data: "💾 خروجی / ورودی اکسل",
} as const;

export type PermKey = keyof typeof PERMS;

/** What an admin may do when nothing was set explicitly. The destructive / money-creating ones stay OFF. */
export const DEFAULT_PERMS: Record<PermKey, boolean> = {
  broadcast: true,
  verify: true,
  badges: true,
  users: true,
  ban: true,
  reports: true,
  jeton: false,
  pricing: false,
  reactionGate: true,
  guides: true,
  settings: true,
  stats: true,
  activityLog: true,
  seeds: true,
  nava: false,
  resetUser: false,
  data: false,
};

export function isPermKey(x: string): x is PermKey {
  return Object.prototype.hasOwnProperty.call(PERMS, x);
}

/** Effective permission of the person behind `ctx`. Owner: always true. Not an admin at all: false. */
export function canAdmin(ctx: NavaContext, perm: PermKey): boolean {
  const id = ctx.from?.id;
  if (!id) return false;
  if (isOwner(ctx)) return true;
  const isStatic = env.ADMIN_IDS.includes(id);
  if (!isStatic && !ctx.dbUser?.isAdmin) return false;
  const set = (ctx.dbUser as any)?.adminPerms as Partial<Record<PermKey, boolean>> | undefined;
  return set?.[perm] ?? DEFAULT_PERMS[perm];
}

export function effectivePerms(u: { adminPerms?: Partial<Record<PermKey, boolean>> } | null | undefined): Record<PermKey, boolean> {
  const out = { ...DEFAULT_PERMS };
  for (const k of Object.keys(PERMS) as PermKey[]) if (typeof u?.adminPerms?.[k] === "boolean") out[k] = u!.adminPerms![k]!;
  return out;
}

/** Which permission each admin-keyboard label needs (labels not listed here are open to every admin). */
export function labelPermissions(L: Record<string, string>): Record<string, PermKey> {
  const m: Record<string, PermKey> = {};
  const put = (labels: string[], p: PermKey) => labels.forEach((x) => x && (m[x] = p));
  put([L.broadcast!], "broadcast");
  put([L.verify!, L.verifiedUsers!], "verify");
  put([L.badges!], "badges");
  put([L.userList!, L.search!, L.fullProfile!], "users");
  put([L.ban!, L.unban!], "ban");
  put([L.reports!], "reports");
  put([L.relic!], "jeton");
  put([L.pricing!, L.shop!], "pricing");
  put([L.reactionGate!], "reactionGate");
  put([L.guidesAndChannels!], "guides");
  put([L.settings!], "settings");
  put([L.stats!], "stats");
  put([L.activityLog!], "activityLog");
  put([L.seedPanel!, L.seedAdd!, L.seedBatch!, L.seedList!], "seeds");
  put([L.ngSettings!, L.ngGifts!, L.ngGiftAdd!], "nava");
  put([L.resetUser!], "resetUser");
  put([L.exportUsers!, L.importUsers!], "data");
  return m;
}
