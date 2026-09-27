import type { Language } from "../db/models/user.js";
export type { Language };
import type { Dictionary } from "./types.js";
import { fa } from "./locales/fa.js";
import { en } from "./locales/en.js";
import { ar } from "./locales/ar.js";
import { env } from "../config/env.js";

const locales: Record<Language, Dictionary> = { fa, en, ar };

export function dictionary(lang: Language): Dictionary {
  return locales[lang];
}

export function isRtl(lang: Language): boolean {
  // Persian and Arabic are RTL; English is LTR (Feature 01 requirement).
  return lang === "fa" || lang === "ar";
}

/**
 * Thrown/logged whenever a LOCKED string has not been supplied yet for the
 * requested language. This makes a missing translation impossible to miss
 * during development/testing, and NEVER silently falls back to another
 * language at runtime (per the absolute "never mix languages" rule).
 */
export class MissingTranslationError extends Error {
  constructor(lang: Language, path: string) {
    super(`[i18n] Missing "${path}" translation for language "${lang}".`);
    this.name = "MissingTranslationError";
  }
}

/**
 * Safely reads a LOCKED, possibly-undefined string/function out of a
 * dictionary. In development/test this throws immediately (loud failure,
 * easy to catch in review). In production it logs an error and returns a
 * short, clearly-not-real-content placeholder rather than text from a
 * different language — this should never actually happen in production
 * because required content should be filled in before deploying a new
 * language, but the bot must not crash on a real user's request either way.
 */
export function requireLocked<T>(lang: Language, path: string, value: T | undefined): T {
  if (value !== undefined) return value;

  const err = new MissingTranslationError(lang, path);
  if (!env.isProduction) {
    throw err;
  }
  // eslint-disable-next-line no-console
  console.error(err.message);
  // Minimal, language-neutral placeholder — intentionally not "real" content.
  return "…" as unknown as T;
}
