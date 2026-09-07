import { env } from "./env.js";

/**
 * Centralized Premium/Custom Emoji configuration.
 *
 * Telegram Premium custom emojis can only be used by a bot if:
 *  - the emoji is referenced inside HTML-formatted text using the
 *    <tg-emoji emoji-id="..."> tag (requires the BOT ACCOUNT owner to have
 *    Telegram Premium), or
 *  - as `icon_custom_emoji_id` on an InlineKeyboardButton / KeyboardButton
 *    (Bot API 9.4+).
 *
 * The actual numeric IDs are supplied by the project owner via environment
 * variables (see .env.example). If an ID is missing, we NEVER crash the bot:
 * we fall back to the plain Unicode emoji and log a warning so the missing
 * configuration is easy to spot during development.
 */

export type EmojiKey = keyof typeof env.emoji;

const warned = new Set<string>();

function warnMissing(key: string) {
  if (env.isProduction) return; // do not spam logs in production
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[emoji] EMOJI_PREMIUM_${key} is not configured. Falling back to plain Unicode emoji.`);
}

/**
 * Returns HTML markup for a premium custom emoji to embed inside a message
 * sent with parse_mode "HTML". `fallback` is the plain Unicode emoji shown
 * to clients that cannot render custom emoji and is REQUIRED by Telegram
 * as the tag's inner content.
 */
export function textEmoji(key: EmojiKey, fallback: string): string {
  const id = env.emoji[key];
  if (!id) {
    warnMissing(key);
    return fallback;
  }
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/**
 * Returns the custom_emoji_id to attach to a button's `icon_custom_emoji_id`
 * field, or undefined when not configured (button is simply rendered
 * without an icon in that case).
 */
export function buttonIcon(key: EmojiKey): string | undefined {
  const id = env.emoji[key];
  if (!id) {
    warnMissing(key);
    return undefined;
  }
  return id;
}
