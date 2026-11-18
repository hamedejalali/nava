import { escapeHtml } from "../utils/html.js";
import { emojiSyntaxToHtml } from "./emojiSyntax.js";

/** The profile card as a template: {variables} are filled by the bot and never edited; the text around them is the owner's. */
export const PROFILE_VARS = ["name", "age", "gender", "province", "city", "level", "bio", "trust", "online", "id", "mini", "distance"] as const;
export const PROFILE_VAR_HELP: Record<(typeof PROFILE_VARS)[number], string> = {
  name: "نام (با تیک)", age: "سن", gender: "جنسیت", province: "استان", city: "شهر", level: "سطح کاربر", bio: "بیوگرافی",
  trust: "وضعیت تأیید", online: "وضعیت آنلاین", id: "آیدی", mini: "یوزرنیم مینی‌اپ", distance: "فاصله",
};
export const DEFAULT_PROFILE_TEMPLATE =
  "نام : {name}\nسن : {age}\nجنسیت : {gender}\nاستان : {province}\nشهر : {city}\n⭐ سطح کاربر: {level}\n\n📝 بیوگرافی : {bio}\n\n{trust}\n{online}\n🆔 آیدی : {id}\n🏷 یوزرنیم مینی‌اپ: {mini}\n{distance}";
export const PROFILE_TEMPLATE_ID = "tpl:profileCard";

export function unknownVars(tpl: string): string[] {
  const bad = new Set<string>();
  for (const m of tpl.matchAll(/\{([^{}\n]*)\}/g)) if (!(PROFILE_VARS as readonly string[]).includes(m[1]!)) bad.add(m[0]);
  return [...bad];
}

/** `values` are ALREADY html-safe. A line whose variable is empty is dropped (no bio → no bio line); blank-line runs collapse. */
export function renderTemplate(tpl: string, values: Record<string, string>): string {
  const lines: string[] = [];
  for (const raw of tpl.replace(/(?<!:)\/\//g, "\n").split("\n")) {
    let empty = false;
    const out = raw
      .split(/(\{[a-z]+\})/)
      .map((part) => {
        const m = /^\{([a-z]+)\}$/.exec(part);
        if (!m) return emojiSyntaxToHtml(part);
        const v = values[m[1]!];
        if (v === undefined) return escapeHtml(part);
        if (v === "") empty = true;
        return v;
      })
      .join("");
    if (!empty) lines.push(out);
  }
  const res: string[] = [];
  for (const l of lines) if (!(l.trim() === "" && (res.length === 0 || res[res.length - 1]!.trim() === ""))) res.push(l);
  while (res.length && res[res.length - 1]!.trim() === "") res.pop();
  return res.join("\n");
}

export const SAMPLE_PROFILE_VALUES: Record<string, string> = {
  name: "Ham ✅", age: "29", gender: "پسر", province: "تهران", city: "تهران", level: "🌱 تازه‌وارد", bio: "Slm",
  trust: "✅ (این کاربر مورد اعتماد می‌باشد و توسط ادمین تایید شده)", online: "🟢 آنلاین", id: "<code>user_Hf13vM</code>", mini: "<code>@Dash</code>", distance: "",
};
