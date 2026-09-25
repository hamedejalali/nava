/**
 * Reusable "Glass" button system used throughout the entire bot.
 *
 * Telegram Bot API 9.4 (Feb 2026) added a real `style` field to
 * InlineKeyboardButton/KeyboardButton with three solid background colors
 * ("primary" = blue, "success" = green, "danger" = red) plus
 * `icon_custom_emoji_id` for a leading Premium Emoji icon. There is still
 * no true frosted-glass/blur rendering in a normal chat (that only exists
 * inside a Telegram Mini App's own HTML/CSS) — these three native colors
 * are the closest real, currently-supported equivalent, and are what this
 * project uses everywhere a "colorful Glass-style button" is required.
 *
 * Keeping this in one place means every feature gets the same look and the
 * same color-cycling behavior for free.
 */

import type { ButtonIcon } from "../config/emojis.js";

export type GlassStyle = "primary" | "success" | "danger";

/** What callers may pass as the button icon: the result of
 *  `buttonIcon(...)` (preferred), or a raw custom-emoji id string. */
export type IconInput = ButtonIcon | string | undefined;

/** Premium ID only (never the plain fallback) — for buttons whose label
 *  already contains its own plain emoji (e.g. the admin panel). */
export function iconIdOnly(icon: IconInput): string | undefined {
  if (!icon) return undefined;
  return typeof icon === "string" ? icon : icon.id;
}

/** Resolves an icon into either an `icon_custom_emoji_id` (premium) or a
 *  plain emoji prefixed to the label (normal emoji fallback), so a button
 *  ALWAYS shows an emoji and never breaks when a premium ID is removed. */
function withIcon(text: string, icon: IconInput, plainFallbackInText: boolean): { text: string; iconId?: string } {
  if (!icon) return { text };
  if (typeof icon === "string") return { text, iconId: icon };
  if (icon.id) return { text, iconId: icon.id };
  if (!plainFallbackInText || !icon.fallback) return { text };
  return { text: `${icon.fallback} ${text}` };
}

const STYLE_CYCLE: readonly GlassStyle[] = ["primary", "success", "danger"];

/** Cycles through the 3 available native colors so a long list of buttons
 *  (e.g. the 9-99 age keyboard) still alternates colors as required. */
export function styleForIndex(index: number): GlassStyle {
  return STYLE_CYCLE[((index % STYLE_CYCLE.length) + STYLE_CYCLE.length) % STYLE_CYCLE.length]!;
}

export interface GlassCallbackButton {
  text: string;
  callback_data: string;
  style?: GlassStyle;
  icon_custom_emoji_id?: string;
}

export interface GlassUrlButton {
  text: string;
  url: string;
  style?: GlassStyle;
  icon_custom_emoji_id?: string;
}

/**
 * Builds a callback-data Glass button. `icon` should come from
 * src/config/emojis.ts (`buttonIcon(...)`): with a premium ID configured
 * the button shows that premium emoji; without one, the plain fallback
 * emoji is put in front of the label instead (never crashes, never blank).
 */
export function glassButton(text: string, callbackData: string, style: GlassStyle, icon?: IconInput): GlassCallbackButton {
  const resolved = withIcon(text, icon, true);
  const button: GlassCallbackButton = { text: resolved.text, callback_data: callbackData, style };
  if (resolved.iconId) button.icon_custom_emoji_id = resolved.iconId;
  return button;
}

export function glassUrlButton(text: string, url: string, style: GlassStyle, icon?: IconInput): GlassUrlButton {
  const resolved = withIcon(text, icon, true);
  const button: GlassUrlButton = { text: resolved.text, url, style };
  if (resolved.iconId) button.icon_custom_emoji_id = resolved.iconId;
  return button;
}

/** Splits a flat list of buttons into rows of `perRow` columns, preserving order. */
export function toRows<T>(buttons: T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

/** Wraps rows of buttons into the shape grammY/Bot API expects for
 *  `reply_markup` on sendMessage/editMessageText. */
export function inlineKeyboard(rows: Array<Array<GlassCallbackButton | GlassUrlButton>>) {
  return { inline_keyboard: rows };
}

export interface GlassReplyButton {
  text: string;
  style?: GlassStyle;
  icon_custom_emoji_id?: string;
  /** Telegram's native "share my phone number" button. */
  request_contact?: boolean;
}

/** A reply-keyboard button that asks Telegram to send the user's OWN phone
 *  contact when tapped (the only way to get a number Telegram vouches for). */
export function contactReplyButton(text: string, style: GlassStyle): GlassReplyButton {
  return { text, style, request_contact: true };
}

/** A Reply Keyboard (the persistent keyboard docked below the chat input,
 *  as opposed to an inline keyboard attached to one message) button that
 *  uses the SAME Bot API 9.4 `style`/`icon_custom_emoji_id` fields as
 *  glassButton — KeyboardButton got the identical upgrade, so these can be
 *  genuinely colorful too, not just plain text. Tapping one sends its
 *  `text` back as an ordinary text message (there is no callback_data for
 *  reply-keyboard buttons); handlers match on that text. */
export function glassReplyButton(text: string, style: GlassStyle, icon?: IconInput): GlassReplyButton {
  // NOTE: when the plain fallback is put in front of the label, the tap
  // arrives as "<emoji> <label>" — handlers that match labels must strip
  // the leading emoji first (see matchMainMenuAction).
  const resolved = withIcon(text, icon, true);
  const button: GlassReplyButton = { text: resolved.text, style };
  if (resolved.iconId) button.icon_custom_emoji_id = resolved.iconId;
  return button;
}

/** Wraps rows of reply-keyboard buttons into a persistent ReplyKeyboardMarkup. */
export function replyKeyboard(rows: GlassReplyButton[][], options: { oneTime?: boolean } = {}) {
  return {
    keyboard: rows,
    resize_keyboard: true,
    one_time_keyboard: !!options.oneTime,
  };
}

export function removeReplyKeyboard() {
  return { remove_keyboard: true as const };
}
