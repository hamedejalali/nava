import { escapeHtml } from "../../utils/html.js";
import { inlineKeyboard } from "../../ui/keyboard.js";
import { buildSupportButton } from "./index.js";

export const BAN_NOTICE_TEXT = "🚫 شما مسدود شدید.\nبرای رفع مسدودی از دکمه‌ی زیر به پشتیبانی پیام بدید.";

/** Text of the "you are banned" notice (HTML-safe), with the reason when there is one. */
export function banNoticeText(reason?: string): string {
  return `${BAN_NOTICE_TEXT}${reason ? `\n\nدلیل: ${escapeHtml(reason)}` : ""}`;
}

/** A link button that opens a chat with support — NOT the support id as text. Absent when no support
 *  contact is configured yet (the notice is still shown). */
export async function banNoticeMarkup() {
  const btn = await buildSupportButton("📩 پیام به پشتیبانی");
  return btn ? inlineKeyboard([[btn]]) : undefined;
}
