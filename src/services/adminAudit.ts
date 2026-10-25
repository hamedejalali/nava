import { botApi } from "./miniapp.js";
import { getLogChatId } from "./channelRouting.js";
import { getDb } from "../db/connect.js";

/** Human sentence for the admin-log channel (route «adminLog»). Best effort: a failure never blocks the admin's action. */
const TEXT: Record<string, (who: string, d: string[]) => string> = {
  jeton_send: (w, d) => `${w} ${d[1]} ژتون به ${d[0]} ارسال کرد`,
  jeton_deduct: (w, d) => `${w} ${d[1]} ژتون از ${d[0]} کسر کرد`,
  ban_user: (w, d) => `${w} کاربر ${d[0]} را بن کرد`,
  unban_user: (w, d) => `${w} کاربر ${d[0]} را آن‌بن کرد`,
  toggle_verify: (w, d) => `${w} وضعیت وریفای ${d[0]} را تغییر داد`,
  reset_user: (w, d) => `${w} اطلاعات ${d[0]} را ریست کرد`,
  grant_admin: (w, d) => `${w} ${d[0]} را ادمین کرد`,
  revoke_admin: (w, d) => `${w} ادمین ${d[0]} را برداشت`,
  set_badges: (w, d) => `${w} بج‌های ${d[0]} را تغییر داد`,
  admin_perms: (w, d) => `${w} دسترسی ${d[0]} را تغییر داد (${d.slice(1).join(" ")})`,
};

async function nameOf(id: string): Promise<string> {
  if (!/^\d+$/.test(id)) return id;
  try {
    const u = await (await getDb()).collection<any>("users").findOne({ _id: Number(id) as any }, { projection: { nickname: 1, anonId: 1 } });
    return u ? `${u.nickname ?? "-"} (${u.anonId ?? id})` : id;
  } catch {
    return id;
  }
}

export async function announceAdminAction(adminId: number, action: string, details?: string): Promise<void> {
  try {
    const chat = await getLogChatId("adminLog");
    if (chat === undefined) return;
    const parts = (details ?? "").split(":");
    const d = await Promise.all(parts.map((x, i) => (i === 0 ? nameOf(x) : Promise.resolve(x))));
    const who = await nameOf(String(adminId));
    const line = TEXT[action]?.(who, d) ?? `${who} → ${action}${details ? ` (${details})` : ""}`;
    await botApi().sendMessage(chat, `🔐 ${line}`);
  } catch {
    /* never blocks the action */
  }
}
