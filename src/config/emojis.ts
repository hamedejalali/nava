import { env } from "./env.js";

/**
 * Centralized Premium/Custom Emoji configuration.
 *
 * HOW IT WORKS (Bot API 9.4+, requires the bot OWNER to have Telegram Premium):
 *  - In message TEXT / CAPTION a premium emoji is written as
 *      <tg-emoji emoji-id="ID">🙂</tg-emoji>
 *    and the message MUST be sent with parse_mode "HTML".
 *    (src/ui/telegramSafety.ts guarantees that automatically, so a forgotten
 *    parse_mode can never again leak the raw tag to users.)
 *  - On a BUTTON the emoji is NOT written in the text. It goes in the
 *    `icon_custom_emoji_id` field (see src/ui/keyboard.ts).
 *
 * THE ONE RULE YOU ASKED FOR:
 *  The IDs live ONLY in .env / Vercel env. To go back to a normal emoji, just
 *  empty the variable (or set PREMIUM_EMOJI_ENABLED=false to turn ALL of them
 *  off at once) and redeploy. Every place then falls back to a plain Unicode
 *  emoji automatically — text, buttons, and even old texts stored in the DB.
 */

export type EmojiKey = keyof typeof env.emoji;

/* ------------------------------------------------------------------ admin-panel overrides (v1.26)
 * The owner can switch premium emoji on/off and replace any single emoji (premium ID or plain emoji) from the admin panel.
 * The values live in Mongo (`emoji_config`) and are mirrored here in memory (reloaded at most every 20 s per instance),
 * so the many synchronous callers (textEmoji / buttonIcon / the sanitizer) stay synchronous. The .env values are the default. */
interface EmojiOverrides {
  enabled?: boolean;
  map: Record<string, string>;
}
let overrides: EmojiOverrides = { map: {} };
let overridesLoadedAt = 0;

export function setEmojiOverrides(o: EmojiOverrides): void {
  overrides = { enabled: o.enabled, map: { ...o.map } };
  overridesLoadedAt = Date.now();
  allowedIdsCache = null;
}
export function emojiOverridesLoadedAt(): number {
  return overridesLoadedAt;
}
export function currentEmojiOverrides(): EmojiOverrides {
  return overrides;
}
/** master switch: the panel value wins over PREMIUM_EMOJI_ENABLED when it was set */
export function premiumEnabled(): boolean {
  return overrides.enabled ?? env.PREMIUM_EMOJI_ENABLED;
}
/** raw configured value for a key: panel override first, then .env */
export function emojiRaw(key: EmojiKey): string | undefined {
  return overrides.map[key] ?? env.emoji[key];
}

/** Plain Unicode emoji used whenever a premium ID is missing/disabled. */
export const DEFAULT_EMOJI: Record<EmojiKey, string> = {
  WORLD: "🌍",
  MALE: "👦",
  FEMALE: "👧",
  AGE: "🎂",
  FLAG_FA: "🇮🇷",
  FLAG_EN: "🇬🇧",
  FLAG_AR: "🇸🇦",
  HOME: "🏠",
  PERSON: "👤",
  GREEN_CHECK: "✅",
  GUIDE: "📖",
  ANONYMOUS: "🎭",
  LOCATION: "📍",
  SEARCH: "🔎",
  TIMER: "⏳",
  PROFILE: "👤",
  CROWN: "👑",
  MAILBOX: "📬",
  LETTER: "✉️",
  INVITE: "🎁",
  BACK: "🔙",
  CHANNEL: "📣",
  COURT: "⚖️",
  DICE: "🎲",
  PEOPLE: "👥",
  CONTACT: "👤",
  LOCK: "🔒",
  BOT: "🤖",
  HEART: "❤️",
  MESSAGE: "💬",
  PLUS: "➕",
  REPORT: "🚫",
  NOTIFICATION: "🔔",
  BIOGRAPHY: "📝",
  CHAT_STATUS: "💬",
  AT_SIGN: "🆔",
  SUPPORT: "🛟",
  LEVEL_NEWCOMER: "🌱",
  LEVEL_NORMAL: "⭐",
  LEVEL_ACTIVE: "🔥",
  LEVEL_PROFESSIONAL: "💎",
  LEVEL_SPECIAL: "👑",
  LEVEL_LEGEND: "🏆",
  OWNER_BADGE: "👑",
  ADMIN_BADGE: "🛡️",
  VERIFIED_BADGE: "✅",
  BAN: "🚫",
  UNBAN: "🔓",
  STATS: "📊",
  LOG: "🔐",
  SETTINGS: "⚙️",
  BROADCAST: "📢",
  USERS: "👥",
  P1: "1️⃣",
  P2: "2️⃣",
  P3: "3️⃣",
  P4: "4️⃣",
  P5: "5️⃣",
  RESET_USER: "♻️",
  RELIC: "💰",
  NAVA: "🌐",
  VERIFY_REQUEST: "✅",
  CONTACTS: "📇",
  LIKE: "👍",
  INVITE_INTRO: "💬",
  INVITE_ANON: "💬",
  INVITE_FEATURES: "💬",
  INVITE_CTA: "💬",
  INVITE_LINK: "💬",
  INVITE_VERIFIED: "☑️",
  INVITE_PROFILE_BONUS: "➕",
  INVITE_REFERRAL_BONUS: "💬",
  INVITE_BANNER_READY: "⚡️",
  INVITE_COUNT: "👈",
};

const warned = new Set<string>();

function warnMissing(key: string) {
  if (env.isProduction) return; // do not spam logs in production
  if (warned.has(key)) return;
  warned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[emoji] EMOJI_PREMIUM_${key} is not configured. Falling back to plain Unicode emoji.`);
}

/**
 * Forgiving parser for an emoji ID coming from .env: accepts a bare number,
 * a quoted number, or even a whole pasted `<tg-emoji emoji-id="123">🙂</tg-emoji>`
 * / `emoji-id="123"`. Returns undefined when nothing usable is there.
 */
export function cleanEmojiId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /\d{6,}/.exec(raw);
  return match ? match[0] : undefined;
}

/**
 * The plain (normal) emoji written in .env for a key, e.g.
 *   EMOJI_PREMIUM_HOME=🏠          -> "🏠"
 *   EMOJI_PREMIUM_HOME=5416041192905265756      -> (id only, no plain emoji)
 *   EMOJI_PREMIUM_HOME=5416041192905265756 🏠   -> "🏠" (+ the ID)
 * This lets you keep ordinary emoji in .env while you have no Telegram
 * Premium, and later just replace the value with the numeric ID.
 * Takes precedence over the fallback hard-coded in the code.
 */
export function envPlainEmoji(key: EmojiKey): string | undefined {
  const raw = emojiRaw(key);
  if (!raw) return undefined;
  const rest = raw.replace(/\d{6,}/g, "").replace(/["'`]/g, "").trim();
  if (!rest || /[<>]/.test(rest) || rest.length > 16) return undefined;
  return rest;
}

/** Resolved premium ID for a key, or undefined when missing OR when the
 *  master switch PREMIUM_EMOJI_ENABLED is off. */
export function premiumId(key: EmojiKey): string | undefined {
  if (!premiumEnabled()) return undefined;
  return cleanEmojiId(emojiRaw(key));
}

let allowedIdsCache: Set<string> | null = null;
/** Every premium ID currently configured in env (empty when disabled).
 *  Used as a WHITELIST by the outgoing-message sanitizer: a `<tg-emoji>`
 *  tag whose ID is not configured anymore (or was typed by a user / stored
 *  in an old DB text) is silently downgraded to its plain emoji. */
export function allowedPremiumIds(): Set<string> {
  if (!premiumEnabled()) return new Set();
  if (!allowedIdsCache) {
    const set = new Set<string>();
    for (const key of Object.keys(env.emoji) as EmojiKey[]) {
      const id = cleanEmojiId(emojiRaw(key));
      if (id) set.add(id);
    }
    allowedIdsCache = set;
  }
  return allowedIdsCache;
}

/**
 * Returns HTML markup for a premium custom emoji to embed inside a message
 * sent with parse_mode "HTML". `fallback` is the plain Unicode emoji shown
 * when no premium ID is configured (and is REQUIRED by Telegram as the
 * tag's inner content).
 */
export function textEmoji(key: EmojiKey, fallback?: string): string {
  const plain = envPlainEmoji(key) ?? fallback ?? DEFAULT_EMOJI[key];
  const id = premiumId(key);
  if (!id) {
    if (premiumEnabled()) warnMissing(key);
    return plain;
  }
  return `<tg-emoji emoji-id="${id}">${plain}</tg-emoji>`;
}

/** What a button needs to show an emoji: the premium ID when configured,
 *  otherwise the plain emoji that keyboard.ts puts in front of the label. */
export interface ButtonIcon {
  id?: string;
  fallback: string;
}

export function buttonIcon(key: EmojiKey, fallback?: string): ButtonIcon {
  const id = premiumId(key);
  if (!id && premiumEnabled()) warnMissing(key);
  return { id, fallback: envPlainEmoji(key) ?? fallback ?? DEFAULT_EMOJI[key] };
}
