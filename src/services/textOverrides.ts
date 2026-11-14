import { getDb } from "../db/connect.js";
import { setDictionaryOverride, type Language } from "../i18n/index.js";
import { escapeHtml } from "../utils/html.js";
import { emojiSyntaxToHtml } from "./emojiSyntax.js";

/**
 * v1.31.0 — owner-edited texts, per language (fa / en / ar). Collection `ui_texts`:
 *   { _id: "d:<lang>:<dictionary path>", text }     replaces one string of the locale dictionary (applied in memory)
 *   { _id: "t:profileCard:<lang>", text }           the profile-card template (placeholders in {braces} = variables, never edited)
 * Reloaded at most every 20 s per instance.
 */
export const LANGS: Language[] = ["fa", "en", "ar"];
export const LANG_FA: Record<Language, string> = { fa: "🇮🇷 فارسی", en: "🇬🇧 English", ar: "🇸🇦 العربية" };

interface Doc {
  _id: string;
  text: string;
}
const col = async () => (await getDb()).collection<Doc>("ui_texts");

let loadedAt = 0;
const appliedDict = new Set<string>();
const templates = new Map<string, string>();

export async function loadTextOverrides(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 20_000) return;
  try {
    const docs = await (await col()).find({}).toArray();
    loadedAt = Date.now();
    const seen = new Set<string>();
    templates.clear();
    for (const d of docs) {
      if (d._id.startsWith("d:")) {
        const [, lang, ...rest] = d._id.split(":");
        const path = rest.join(":");
        if (setDictionaryOverride(lang as Language, path, d.text)) {
          seen.add(d._id);
          appliedDict.add(d._id);
        }
      } else if (d._id.startsWith("t:")) templates.set(d._id.slice(2), d.text);
    }
    for (const id of [...appliedDict]) {
      if (seen.has(id)) continue;
      const [, lang, ...rest] = id.split(":");
      setDictionaryOverride(lang as Language, rest.join(":"), undefined);
      appliedDict.delete(id);
    }
  } catch {
    /* keep what we have */
  }
}

export async function saveTextOverride(id: string, text: string | null): Promise<void> {
  const c = await col();
  if (text === null) await c.deleteOne({ _id: id });
  else await c.updateOne({ _id: id }, { $set: { text } }, { upsert: true });
  await loadTextOverrides(true);
}
export async function getTextOverride(id: string): Promise<string | undefined> {
  return (await (await col()).findOne({ _id: id }))?.text;
}

/* ------------------------------------------------------------------ profile card template */
export const PROFILE_VARS = ["name", "age", "gender", "province", "city", "level", "bio", "trust", "online", "id", "mini", "distance"] as const;
export const PROFILE_VAR_HELP: Record<(typeof PROFILE_VARS)[number], string> = {
  name: "نام (با تیک)", age: "سن", gender: "جنسیت", province: "استان", city: "شهر", level: "سطح کاربر", bio: "بیوگرافی",
  trust: "وضعیت تأیید", online: "وضعیت آنلاین", id: "آیدی", mini: "یوزرنیم مینی‌اپ", distance: "فاصله",
};
export const DEFAULT_PROFILE_TEMPLATE =
  "نام : {name}\nسن : {age}\nجنسیت : {gender}\nاستان : {province}\nشهر : {city}\n⭐ سطح کاربر: {level}\n\n📝 بیوگرافی : {bio}\n\n{trust}\n{online}\n🆔 آیدی : {id}\n🏷 یوزرنیم مینی‌اپ: {mini}\n{distance}";

export const profileTemplate = (lang: Language): string | undefined => templates.get(`profileCard:${lang}`);

/** variables used in a template that do not exist (empty = valid) */
export function unknownVars(tpl: string): string[] {
  const bad = new Set<string>();
  for (const m of tpl.matchAll(/\{([^{}\n]*)\}/g)) if (!(PROFILE_VARS as readonly string[]).includes(m[1]!)) bad.add(m[0]);
  return [...bad];
}

/** Renders a template. `values` are ALREADY html-safe. A line whose variable is empty is dropped entirely (e.g. no bio → no bio line);
 *  runs of blank lines collapse into one. Literal text goes through the emoji syntax / HTML escaping. */
export function renderTemplate(tpl: string, values: Record<string, string>): string {
  const lines: string[] = [];
  for (const raw of tpl.split("\n")) {
    let empty = false;
    const parts = raw.split(/(\{[a-z]+\})/);
    const out = parts
      .map((part) => {
        const m = /^\{([a-z]+)\}$/.exec(part);
        if (!m) return emojiSyntaxToHtml(part);
        const v = values[m[1]!];
        if (v === undefined) return escapeHtml(part);
        if (v === "") empty = true;
        return v;
      })
      .join("");
    if (empty) continue;
    lines.push(out);
  }
  const res: string[] = [];
  for (const l of lines) if (!(l.trim() === "" && (res.length === 0 || res[res.length - 1]!.trim() === ""))) res.push(l);
  while (res.length && res[res.length - 1]!.trim() === "") res.pop();
  return res.join("\n");
}

export const SAMPLE_PROFILE_VALUES: Record<string, string> = {
  name: "Jjl ✅", age: "29", gender: "پسر", province: "تهران", city: "تهران", level: "🌱 تازه‌وارد", bio: "Slm",
  trust: "✅ (این کاربر مورد اعتماد می‌باشد و توسط ادمین تایید شده)", online: "🟢 آنلاین", id: "<code>user_QXtQlv</code>", mini: "<code>@hamede</code>", distance: "",
};
