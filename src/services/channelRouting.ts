import { env } from "../config/env.js";
import { getBotSettings } from "../db/models/settings.js";

/**
 * ONE place that decides where every staff-facing message goes (v1.26).
 * Each kind of message ("purpose") can be sent to the management channel, to the owner's DM, or switched off —
 * all set from the admin panel («📡 کانال‌ها و مسیر پیام‌ها»). Nothing is hard-wired to a specific chat any more.
 *
 * Fallback chain for the "management channel": the channel set in the panel → env MODERATION_LOG_CHAT_ID (old
 * variable, still honoured) → the owner's DM (and every admin when OWNER_ID is not set), so a request is never
 * silently sent to nobody.
 */
export type RouteDest = "mgmt" | "dm" | "off";

export const ROUTE_PURPOSES = {
  photo: "🖼 تایید عکس پروفایل",
  verify: "☑️ درخواست وریفای",
  profileEdit: "✏️ درخواست تغییر پروفایل",
  report: "⚠️ گزارش کاربران",
  postReport: "📮 گزارش پست‌ها",
  feedback: "📬 پیشنهادات و انتقادات",
  chatPhoto: "📷 عکس‌های داخل چت",
  dmLog: "💬 لاگ پیام‌های دایرکت",
  seedLog: "🎭 چت ممبرهای فرضی",
  monitor: "📈 هشدارهای مانیتور",
  wallet: "🔌 رسید واریز ولت",
  adminLog: "🔐 لاگ کارهای ادمین‌ها",
} as const;

export type RoutePurpose = keyof typeof ROUTE_PURPOSES;

export function isRoutePurpose(x: string): x is RoutePurpose {
  return Object.prototype.hasOwnProperty.call(ROUTE_PURPOSES, x);
}

export async function routeOf(purpose: RoutePurpose): Promise<RouteDest> {
  const s = await getBotSettings();
  const r = s.routes?.[purpose];
  return r === "dm" || r === "off" || r === "mgmt" ? r : "mgmt";
}

async function ownerOrAdmins(): Promise<number[]> {
  const { getRequestRecipientIds } = await import("../features/admin/constants.js");
  return getRequestRecipientIds();
}

/** Chat ids (channel and/or people) that must receive a message of this kind. Empty array = switched off. */
export async function getRecipients(purpose: RoutePurpose): Promise<number[]> {
  const s = await getBotSettings();
  const dest = await routeOf(purpose);
  if (dest === "off") return [];
  if (dest === "mgmt") {
    const ch = s.managementChannelId ?? env.MODERATION_LOG_CHAT_ID;
    if (ch !== undefined && ch !== null) return [ch];
  }
  return ownerOrAdmins();
}

/** A single channel id for pure log/receipt messages; `undefined` when switched off or no channel is configured. */
export async function getLogChatId(purpose: RoutePurpose): Promise<number | undefined> {
  const s = await getBotSettings();
  const dest = await routeOf(purpose);
  if (dest === "off") return undefined;
  if (dest === "dm") return env.OWNER_ID;
  return s.managementChannelId ?? env.MODERATION_LOG_CHAT_ID;
}
