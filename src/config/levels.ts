import type { UserLevel } from "../db/models/user.js";
import type { EmojiKey } from "./emojis.js";
import { textEmoji } from "./emojis.js";

export const LEVEL_META: Record<UserLevel, { label: string; emojiKey: EmojiKey; fallback: string }> = {
  newcomer: { label: "تازه‌وارد", emojiKey: "LEVEL_NEWCOMER", fallback: "🌱" },
  normal: { label: "معمولی", emojiKey: "LEVEL_NORMAL", fallback: "⭐" },
  active: { label: "فعال", emojiKey: "LEVEL_ACTIVE", fallback: "🔥" },
  professional: { label: "حرفه‌ای", emojiKey: "LEVEL_PROFESSIONAL", fallback: "💎" },
  special: { label: "ویژه", emojiKey: "LEVEL_SPECIAL", fallback: "👑" },
  legend: { label: "لجند", emojiKey: "LEVEL_LEGEND", fallback: "🏆" },
};

export function defaultLevel(): UserLevel {
  return "newcomer";
}

/** Renders "⭐ سطح کاربر: <emoji> <label>" for use inside message text
 *  (HTML parse_mode) — profile screens, welcome messages, etc. */
export function levelDisplay(level: UserLevel | undefined): string {
  const meta = LEVEL_META[level ?? defaultLevel()];
  return `${textEmoji(meta.emojiKey, meta.fallback)} ${meta.label}`;
}
