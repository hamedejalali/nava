import { env } from "../config/env.js";
import { getBotSettings } from "../db/models/settings.js";
import { getContent } from "../db/models/content.js";

/** Default text shown to everybody else while the bot is switched off (editable: ویرایش متن‌ها → متن خاموشی). */
export const DEFAULT_MAINTENANCE_TEXT = "🛠 مویا موقتاً در حال به‌روزرسانی است و به‌زودی با امکانات جدید برمی‌گردیم. ممنون از صبوری‌ت 🌐";

export interface MaintenanceState {
  on: boolean;
  allow: number[];
}

export async function getMaintenanceState(): Promise<MaintenanceState> {
  const s = await getBotSettings();
  return { on: !!s.maintenanceMode, allow: s.maintenanceAllowIds ?? [] };
}

/** Owner and env admins can ALWAYS get in (otherwise nobody could ever switch the bot back on); so can a
 *  dynamically granted admin and anybody on the allow-list. */
export function maintenanceAllows(state: MaintenanceState, userId: number | undefined, user?: { isAdmin?: boolean } | null): boolean {
  if (!state.on) return true;
  if (userId === undefined) return false;
  if (env.OWNER_ID !== undefined && userId === env.OWNER_ID) return true;
  if (env.ADMIN_IDS.includes(userId)) return true;
  if (user?.isAdmin) return true;
  return state.allow.includes(userId);
}

export function maintenanceText(): Promise<string> {
  return getContent("maintenanceText", DEFAULT_MAINTENANCE_TEXT);
}
