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

export type GlassStyle = "primary" | "success" | "danger";

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
 * Builds a callback-data Glass button. `iconCustomEmojiId` should come from
 * src/config/emojis.ts (`buttonIcon(...)`) — pass undefined when the
 * corresponding Premium Emoji hasn't been configured yet; the button simply
 * renders without an icon in that case (never crashes).
 */
export function glassButton(text: string, callbackData: string, style: GlassStyle, iconCustomEmojiId?: string): GlassCallbackButton {
  const button: GlassCallbackButton = { text, callback_data: callbackData, style };
  if (iconCustomEmojiId) button.icon_custom_emoji_id = iconCustomEmojiId;
  return button;
}

export function glassUrlButton(text: string, url: string, style: GlassStyle, iconCustomEmojiId?: string): GlassUrlButton {
  const button: GlassUrlButton = { text, url, style };
  if (iconCustomEmojiId) button.icon_custom_emoji_id = iconCustomEmojiId;
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
