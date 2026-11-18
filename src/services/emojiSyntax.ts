import { escapeHtml } from "../utils/html.js";
import { ownerSyntaxIds, premiumEnabled } from "../config/emojis.js";

/**
 * v1.31.0 — the owner's emoji syntax:  `-😌 -5368324170671202286-`
 *   = "-" + plain emoji + " -" + premium emoji id + "-".
 * Rendering rule (owner rule): premium emoji appear ONLY when the master switch is on AND the owner account currently has
 * Telegram Premium (re-read from the last owner update on every config reload); otherwise the plain emoji is shown.
 * `//` = next line; a real Enter stays a real newline.
 *
 * The owner does NOT type this syntax: he sends a normal Telegram message with a simple emoji followed by a premium emoji
 * (`♥️🔥`, or `♦️♥️🎴🪀` = two pairs); `entitiesToSyntax` turns it into the stored form. Simple emoji = shown when premium is off /
 * the owner has no Premium; premium emoji = shown otherwise. A lone simple emoji is always shown; a lone premium emoji shows its own character
 * as the fallback.
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
  return nl(text).replace(EMOJI_SYNTAX_RE, (_m, plain: string) => plain);
}

/** The owner types `//` for "next line" (a URL's `://` is left alone). Real line breaks stay line breaks too. */
export const nl = (text: string): string => text.replace(/(?<!:)\/\//g, "\n");

/** HTML form for a message (parse_mode HTML): text is escaped, every syntax token becomes <tg-emoji> or the plain emoji. */
export function emojiSyntaxToHtml(text: string, opts: { premium?: boolean } = {}): string {
  text = nl(text);
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

/** Tags for stored texts other code sends as-is (the outgoing safety net escapes the rest and sets parse_mode). */
export function emojiSyntaxToTags(text: string, opts: { premium?: boolean } = {}): string {
  const premium = opts.premium ?? premiumUsable();
  return nl(text).replace(EMOJI_SYNTAX_RE, (_m, plain: string, id: string) => {
    if (premium) ownerSyntaxIds.add(id);
    return premium ? `<tg-emoji emoji-id="${id}">${plain}</tg-emoji>` : plain;
  });
}

/** Button label: the first premium emoji becomes the button icon (premium usable) or a plain emoji prefix. */
export function renderButtonLabel(raw: string, opts: { premium?: boolean } = {}): { text: string; iconId?: string; plain: string } {
  const premium = opts.premium ?? premiumUsable();
  const first = new RegExp(EMOJI_SYNTAX_RE.source, "u").exec(raw);
  const plainAll = raw.replace(EMOJI_SYNTAX_RE, (_m, plain: string) => `${plain} `).replace(/\s+/g, " ").trim();
  if (!first) return { text: raw.trim(), plain: raw.trim() };
  if (!premium) return { text: plainAll, plain: plainAll };
  ownerSyntaxIds.add(first[2]!);
  const rest = raw.replace(EMOJI_SYNTAX_RE, (m, plain: string) => (m === first[0] ? "" : `${plain} `)).replace(/\s+/g, " ").trim();
  return { text: rest || first[1]!, iconId: first[2]!, plain: plainAll };
}

/** Every plain form a tap on this label may arrive as (with / without the emoji prefix). */
export function labelTapForms(raw: string): string[] {
  const withIcon = renderButtonLabel(raw, { premium: true }).text;
  const plain = renderButtonLabel(raw, { premium: false }).text;
  return [...new Set([plain, withIcon, plain.replace(/^[^\p{L}\p{N}]+/u, "").trim()].filter(Boolean))];
}

/* ------------------------------------------------------------------ message → stored form */
const EMOJI_SEQ_END = /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3)(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*$/u;

/**
 * A message the OWNER sent (text + entities) → the stored form. Consecutive premium (custom_emoji) emoji directly after the same
 * number of simple emoji are pairs (`♥️🔥` → `-♥️ -ID-`); an unpaired premium emoji keeps its own character as the fallback.
 */
export function entitiesToSyntax(text: string, entities: Array<{ type: string; offset: number; length: number; custom_emoji_id?: string }> | undefined): string {
  const premium = (entities ?? []).filter((e) => e.type === "custom_emoji" && e.custom_emoji_id).sort((a, b) => a.offset - b.offset);
  if (!premium.length) return text;
  // group contiguous premium emoji
  const groups: Array<typeof premium> = [];
  for (const e of premium) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (g && prev && prev.offset + prev.length === e.offset) g.push(e);
    else groups.push([e]);
  }
  let out = "";
  let cursor = 0;
  for (const g of groups) {
    const start = g[0]!.offset;
    let before = text.slice(cursor, start);
    // up to g.length simple emoji directly before the group, taken from the end
    const simples: string[] = [];
    while (simples.length < g.length) {
      const m = EMOJI_SEQ_END.exec(before);
      if (!m) break;
      simples.unshift(m[0]);
      before = before.slice(0, before.length - m[0].length);
    }
    out += before;
    g.forEach((e, i) => {
      const ch = text.slice(e.offset, e.offset + e.length);
      const fallback = simples[i] ?? ch;
      out += `-${fallback} -${e.custom_emoji_id}-`;
    });
    // leftover simple emoji (more simples than premiums can't happen: we only took g.length)
    cursor = g[g.length - 1]!.offset + g[g.length - 1]!.length;
  }
  return out + text.slice(cursor);
}
