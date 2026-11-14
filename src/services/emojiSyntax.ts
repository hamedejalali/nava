import { escapeHtml } from "../utils/html.js";
import { ownerSyntaxIds, premiumEnabled } from "../config/emojis.js";

/**
 * v1.31.0 — the owner's emoji syntax:  `-😌 -5368324170671202286-`
 *   = "-" + plain emoji + " -" + premium emoji id + "-".
 * Rendering rule (owner rule): premium emoji appear ONLY when the master switch is on AND the owner account currently has
 * Telegram Premium (re-read from the last owner update on every config reload); otherwise the plain emoji is shown.
 * A real Enter stays a real newline. The same syntax works inside button labels (see renderButtonLabel).
 */
export const EMOJI_SYNTAX_RE = /-([^\s\d\-]{1,16}) ?-(\d{6,25})-/gu;

let ownerPremium = false;
export function setOwnerPremium(v: boolean): void {
  ownerPremium = v;
}
export function getOwnerPremium(): boolean {
  return ownerPremium;
}
/** premium emoji may be shown right now */
export function premiumUsable(): boolean {
  return premiumEnabled() && ownerPremium;
}

export function hasEmojiSyntax(text: string): boolean {
  return new RegExp(EMOJI_SYNTAX_RE.source, "u").test(text);
}

/** Plain-text form (always the simple emoji) — for logs and for places that cannot show premium emoji. */
export function emojiSyntaxToPlain(text: string): string {
  return text.replace(EMOJI_SYNTAX_RE, (_m, plain: string) => plain);
}

/** HTML form for a message (parse_mode HTML): text is escaped, every syntax token becomes <tg-emoji> or the plain emoji. */
export function emojiSyntaxToHtml(text: string, opts: { premium?: boolean } = {}): string {
  const premium = opts.premium ?? premiumUsable();
  let out = "";
  let last = 0;
  for (const m of text.matchAll(EMOJI_SYNTAX_RE)) {
    const i = m.index ?? 0;
    out += escapeHtml(text.slice(last, i));
    const plain = m[1]!;
    if (premium) ownerSyntaxIds.add(m[2]!);
    out += premium ? `<tg-emoji emoji-id="${m[2]}">${escapeHtml(plain)}</tg-emoji>` : escapeHtml(plain);
    last = i + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Button label: the FIRST syntax token becomes the button icon (premium) or a plain emoji prefix; the rest is the label.
 *  The returned `plain` is the text a tap will send back for the plain case (used to route taps). */
export function renderButtonLabel(raw: string, opts: { premium?: boolean } = {}): { text: string; iconId?: string; plain: string } {
  const premium = opts.premium ?? premiumUsable();
  const first = new RegExp(EMOJI_SYNTAX_RE.source, "u").exec(raw);
  const plainAll = raw.replace(EMOJI_SYNTAX_RE, (_m, plain: string) => `${plain} `).replace(/\s+/g, " ").trim();
  if (!first) return { text: raw.trim(), plain: raw.trim() };
  const rest = raw.replace(EMOJI_SYNTAX_RE, (m, plain: string) => (m === first[0] ? "" : `${plain} `)).replace(/\s+/g, " ").trim();
  if (premium) {
    ownerSyntaxIds.add(first[2]!);
    return { text: rest || first[1]!, iconId: first[2]!, plain: plainAll };
  }
  return { text: plainAll, plain: plainAll };
}

/** Every distinct plain form a tap on this label may arrive as (with and without the leading emoji). */
export function labelTapForms(raw: string): string[] {
  const r = renderButtonLabel(raw, { premium: true });
  const plain = renderButtonLabel(raw, { premium: false }).text;
  return [...new Set([plain, r.text, plain.replace(/^[^\p{L}\p{N}]+/u, "").trim()].filter(Boolean))];
}

/** For stored texts that other code sends as-is: tokens become `<tg-emoji>` tags (premium usable) or the plain emoji, NOTHING else is
 *  escaped — the outgoing safety transformer (src/ui/telegramSafety.ts) escapes the rest and sets parse_mode. */
export function emojiSyntaxToTags(text: string, opts: { premium?: boolean } = {}): string {
  const premium = opts.premium ?? premiumUsable();
  return text.replace(EMOJI_SYNTAX_RE, (_m, plain: string, id: string) => {
    if (premium) ownerSyntaxIds.add(id);
    return premium ? `<tg-emoji emoji-id="${id}">${plain}</tg-emoji>` : plain;
  });
}
