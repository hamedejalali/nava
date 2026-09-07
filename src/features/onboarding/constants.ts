import type { Language } from "../../db/models/user.js";

export const LANGUAGE_CALLBACK_PREFIX = "lang:";
export const GENDER_CALLBACK_PREFIX = "gender:";
export const AGE_CALLBACK_PREFIX = "age:";
export const PROVINCE_CALLBACK_PREFIX = "prov:";
export const CITY_CALLBACK_PREFIX = "city:";
export const GUIDE_BUTTON_CALLBACK = "guide:open";

export const LANGUAGE_FLAG_FALLBACK: Record<Language, string> = {
  fa: "🇮🇷",
  en: "🇬🇧",
  ar: "🇸🇦",
};

export const LANGUAGE_EMOJI_ENV_KEY: Record<Language, "FLAG_FA" | "FLAG_EN" | "FLAG_AR"> = {
  fa: "FLAG_FA",
  en: "FLAG_EN",
  ar: "FLAG_AR",
};
