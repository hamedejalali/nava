import type { Transformer } from "grammy";
import { allowedPremiumIds } from "../config/emojis.js";
import { env } from "../config/env.js";
import { escapeHtml } from "../utils/html.js";

/**
 * OUTGOING-REQUEST SAFETY NET (installed once in src/bot.ts).
 *
 * Root cause of the "raw <tg-emoji ...> text on screen" bug: premium emoji
 * are plain strings containing an HTML tag, but Telegram only understands
 * that tag when the request carries parse_mode "HTML", and never inside a
 * BUTTON label. Dozens of send-sites forgot one or the other. Instead of
 * trusting every call site forever, every request passes through here:
 *
 *  1. TEXT / CAPTION containing <tg-emoji>:
 *       - no parse_mode given  -> everything except the emoji tags is
 *         HTML-escaped and parse_mode "HTML" is set automatically;
 *       - parse_mode "HTML"    -> left as-is (caller already escaped);
 *       - any other parse_mode -> tags are replaced by their plain emoji.
 *  2. Any <tg-emoji> whose ID is NOT currently configured in env (removed
 *     ID, PREMIUM_EMOJI_ENABLED=false, an old text saved in the DB, or a
 *     tag typed by a user) is downgraded to its plain emoji. => You can
 *     empty an EMOJI_PREMIUM_* variable at any time and nothing breaks.
 *  3. BUTTONS whose label contains <tg-emoji>: the tag is removed from the
 *     label and moved into icon_custom_emoji_id (or replaced by the plain
 *     emoji when the ID isn't allowed). An icon_custom_emoji_id is dropped
 *     when premium emoji are disabled.
 */

const TAG_SOURCE = String.raw`<tg-emoji\s+emoji-id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/tg-emoji>`;
const HAS_TAG = /<tg-emoji\b/i;

const TEXT_FIELD_BY_METHOD: Record<string, "text" | "caption"> = {
  sendMessage: "text",
  editMessageText: "text",
  sendPhoto: "caption",
  sendVideo: "caption",
  sendDocument: "caption",
  sendAnimation: "caption",
  sendAudio: "caption",
  sendVoice: "caption",
  copyMessage: "caption",
  editMessageCaption: "caption",
};

/** Keeps allowed tags (normalised), downgrades the rest to plain emoji. */
function sanitizeTags(text: string): string {
  const allowed = allowedPremiumIds();
  return text.replace(new RegExp(TAG_SOURCE, "gi"), (_m, id: string, inner: string) => {
    const fallback = inner.trim() || "🙂";
    return allowed.has(id) ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback;
  });
}

/** HTML-escapes everything that is NOT a <tg-emoji> tag. */
function escapeAllButTags(text: string): string {
  const splitter = new RegExp(`(${TAG_SOURCE})`, "gi");
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(splitter)) {
    const index = match.index ?? 0;
    parts.push(escapeHtml(text.slice(last, index)));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

function stripTagsToPlain(text: string): string {
  return text.replace(new RegExp(TAG_SOURCE, "gi"), (_m, _id: string, inner: string) => inner.trim());
}

function fixButton(button: any): any {
  if (!button || typeof button !== "object") return button;
  const fixed = { ...button };

  if (typeof fixed.text === "string" && HAS_TAG.test(fixed.text)) {
    const first = new RegExp(TAG_SOURCE, "i").exec(fixed.text);
    const id = first?.[1];
    const inner = first?.[2]?.trim() ?? "";
    if (id && allowedPremiumIds().has(id) && !fixed.icon_custom_emoji_id) {
      // premium: the emoji moves out of the label into the icon field
      const label = fixed.text.replace(new RegExp(TAG_SOURCE, "gi"), "").replace(/\s+/g, " ").trim();
      fixed.icon_custom_emoji_id = id;
      fixed.text = label || inner;
    } else {
      // not allowed anymore: plain emoji stays inside the label
      fixed.text = stripTagsToPlain(fixed.text);
    }
  }

  if (fixed.icon_custom_emoji_id && !env.PREMIUM_EMOJI_ENABLED) {
    delete fixed.icon_custom_emoji_id;
  }
  return fixed;
}

function fixMarkup(markup: any): any {
  if (!markup || typeof markup !== "object") return markup;
  const copy = { ...markup };
  for (const key of ["inline_keyboard", "keyboard"] as const) {
    if (Array.isArray(copy[key])) {
      copy[key] = copy[key].map((row: any) => (Array.isArray(row) ? row.map(fixButton) : row));
    }
  }
  return copy;
}

export const telegramSafetyTransformer: Transformer = (prev, method, payload, signal) => {
  const data: any = payload;
  if (!data || typeof data !== "object") return prev(method, payload, signal);

  const next: any = { ...data };

  const field = TEXT_FIELD_BY_METHOD[method];
  if (field && typeof next[field] === "string" && !next.entities && !next.caption_entities && HAS_TAG.test(next[field])) {
    const mode = next.parse_mode;
    if (mode === undefined) {
      next[field] = sanitizeTags(escapeAllButTags(next[field]));
      next.parse_mode = "HTML";
    } else if (typeof mode === "string" && mode.toUpperCase() === "HTML") {
      next[field] = sanitizeTags(next[field]);
    } else {
      next[field] = stripTagsToPlain(next[field]);
    }
  }

  if (next.reply_markup) next.reply_markup = fixMarkup(next.reply_markup);

  return prev(method, next, signal);
};
