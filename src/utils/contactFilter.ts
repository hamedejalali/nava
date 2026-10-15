/**
 * Detects a Telegram contact being shared in free text: an @username or a t.me / telegram.me / telegram.dog /
 * tg:// link. Used inside anonymous chats, where handing out a Telegram identity is forbidden.
 *
 * Deliberately conservative to avoid false positives: an @name must be 5–32 chars (Telegram's own username rule),
 * start with a letter and must NOT be glued to a preceding word character (so "a@b.com" is not a username).
 */
const USERNAME_RE = /(^|[^A-Za-z0-9_@./])@[A-Za-z][A-Za-z0-9_]{4,31}/;
const LINK_RE = /(?:^|[^A-Za-z0-9])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_+]{3,}|tg:\/\/(?:resolve|join|user)/i;

/** Persian/Arabic digits and the fullwidth "＠" are normalised so they cannot be used to dodge the filter. */
function normalise(text: string): string {
  return text.replace(/＠/g, "@").replace(/[‌​‍⁠]/g, "");
}

export function containsTelegramContact(text: string): boolean {
  if (!text) return false;
  const t = normalise(text);
  return USERNAME_RE.test(t) || LINK_RE.test(t);
}

export const CONTACT_FORBIDDEN_TEXT =
  "⚠️ ارسال آیدی یا لینک تلگرام توی چت ناشناس ممنوعه و پیامت ارسال نشد.\nاگه این کار تکرار بشه ممکنه حسابت محدود بشه.";
