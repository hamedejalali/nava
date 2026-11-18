import { compiledButtons, compiledTexts, type Compiled } from "../db/models/uiOverrides.js";
import { emojiSyntaxToHtml, emojiSyntaxToTags, renderButtonLabel } from "./emojiSyntax.js";

/**
 * Applies the owner's edits to everything the bot SENDS (called from the outgoing safety layer, src/ui/telegramSafety.ts):
 * texts (literal or template with {variables}) and buttons (new name / colour / hidden). Cheap: only entries the owner changed are checked.
 */
const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function renderOwner(raw: string, caps: Record<string, string>, escape: boolean): string {
  let out = "";
  let last = 0;
  const piece = (s: string) => (escape ? emojiSyntaxToHtml(s) : emojiSyntaxToTags(s));
  for (const m of raw.matchAll(VAR_RE)) {
    const i = m.index ?? 0;
    out += piece(raw.slice(last, i));
    out += m[1]! in caps ? caps[m[1]!]! : m[0];
    last = i + m[0].length;
  }
  return out + piece(raw.slice(last));
}

/** literals shorter than this only match a whole message */
const SHORT_LIT = 12;

export function applyText(text: string, parseMode?: string): string {
  const list = compiledTexts();
  if (!list.length || !text) return text;
  const html = typeof parseMode === "string" && parseMode.toUpperCase() === "HTML";
  let out = text;
  for (const c of list) {
    const raw = c.doc.text!;
    const escape = html && !c.hadTag;
    if (c.lit !== undefined) {
      // short literals («ناشناس», «قلب», «سایر»…) would hit unrelated messages as a substring → only whole-message matches
      if (c.lit.length < SHORT_LIT) {
        if (out.trim() === c.lit.trim()) out = renderOwner(raw, {}, escape);
      } else if (out.includes(c.lit)) out = out.split(c.lit).join(renderOwner(raw, {}, escape));
    } else if (c.re) {
      c.re.lastIndex = 0;
      out = out.replace(c.re, (...args: any[]) => {
        const caps: Record<string, string> = {};
        c.vars.forEach((v, i) => (caps[v] = String(args[i + 1] ?? "")));
        return renderOwner(raw, caps, escape);
      });
    }
  }
  return out;
}

function matchButton(label: string): { c: Compiled; caps?: string[] } | undefined {
  for (const c of compiledButtons()) {
    if (c.lit !== undefined) {
      if (label === c.lit) return { c };
    } else if (c.re) {
      c.re.lastIndex = 0;
      const m = new RegExp(`^${c.re.source}$`).exec(label);
      if (m) return { c, caps: m.slice(1) };
    }
  }
  return undefined;
}

function fixOne(b: any): any | null {
  if (!b || typeof b !== "object" || typeof b.text !== "string") return b;
  const hit = matchButton(b.text);
  if (!hit) return b;
  const d = hit.c.doc;
  if (d.hidden) return null;
  const nb = { ...b };
  if (d.text !== undefined) {
    let raw = d.text;
    if (hit.caps) hit.c.vars.forEach((v, i) => (raw = raw.split(`{${v}}`).join(hit.caps![i] ?? "")));
    const r = renderButtonLabel(raw);
    nb.text = r.text;
    if (r.iconId) nb.icon_custom_emoji_id = r.iconId;
    else delete nb.icon_custom_emoji_id;
  }
  if (d.style) {
    if (d.style === "default") delete nb.style;
    else nb.style = d.style;
  }
  return nb;
}

export function applyMarkup(markup: any): any {
  if (!markup || typeof markup !== "object" || !compiledButtons().length) return markup;
  const copy = { ...markup };
  for (const key of ["inline_keyboard", "keyboard"] as const) {
    if (!Array.isArray(copy[key])) continue;
    copy[key] = copy[key]
      .map((row: any) => (Array.isArray(row) ? row.map(fixOne).filter((b: any) => b !== null) : row))
      .filter((row: any) => !Array.isArray(row) || row.length > 0);
  }
  return copy;
}
