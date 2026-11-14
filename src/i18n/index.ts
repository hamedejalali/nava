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

/**
 * True when a language has its LOCKED onboarding wording supplied. English and
 * Arabic are intentionally still empty (see locales/en.ts, ar.ts), so a user
 * who picks them would otherwise land on a screen made of "…" placeholders
 * (production) or an exception (dev/test) with no way forward. Callers use this
 * to keep such users on the language screen instead of dead-ending them.
 */
export function isLanguageReady(lang: Language): boolean {
  const o = locales[lang]?.onboarding;
  return !!o && o.genderPrompt !== undefined && o.genderButtonMale !== undefined && o.genderButtonFemale !== undefined;
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

/* ---------------------------------------------------------------- v1.31.0 owner text overrides
 * The owner edits fixed texts per language from «🎨 طراحی داخلی ربات». An override replaces ONE string leaf of a locale dictionary
 * in memory (functions are never touched). The shipped default is remembered so clearing an override restores it exactly. */
const shipped = new Map<string, unknown>();

function walk(lang: Language, path: string): { parent: Record<string, any>; key: string } | null {
  const parts = path.split(".");
  let cur: any = locales[lang];
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]!];
    if (!cur || typeof cur !== "object") return null;
  }
  return { parent: cur, key: parts[parts.length - 1]! };
}

/** value === undefined restores the shipped text. Only string leaves (or missing ones) can be overridden. */
export function setDictionaryOverride(lang: Language, path: string, value: string | undefined): boolean {
  const at = walk(lang, path);
  if (!at) return false;
  const id = `${lang}:${path}`;
  const current = at.parent[at.key];
  if (typeof current === "function") return false;
  if (!shipped.has(id)) shipped.set(id, current);
  at.parent[at.key] = value === undefined ? shipped.get(id) : value;
  return true;
}

export function dictionaryString(lang: Language, path: string): string | undefined {
  const at = walk(lang, path);
  const v = at?.parent[at.key];
  return typeof v === "string" ? v : undefined;
}

/** every plain-string leaf of the Persian dictionary (path → shipped text) — the list the owner's text editor shows */
export function listDictionaryLeaves(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const rec = (o: any, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push({ path, text: (shipped.get(`fa:${path}`) as string | undefined) ?? v });
      else if (v && typeof v === "object") rec(v, path);
    }
  };
  rec(locales.fa, "");
  return out;
}
