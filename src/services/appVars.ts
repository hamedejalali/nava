import { getDb } from "../db/connect.js";

/**
 * v1.27 — "variables that live in the admin panel instead of Vercel env".
 *
 * Every NON-secret setting (photo file_ids, channel ids, thresholds, usernames, …) is stored in the single
 * `bot_settings` document under `vars.<KEY>`. Reading order:
 *   1. the value set from the admin panel («🧩 متغیرها و تصاویر»),
 *   2. the legacy environment variable with the SAME name (first use copies it into the database, so after one
 *      successful run the variable can be deleted from Vercel without losing anything).
 * Secrets (bot token, database URI, wallet secret, …) are NEVER stored here — they stay in env.
 *
 * The catalog (labels/groups for the panel screen) lives in `src/features/admin/varsAdmin.ts`; this file is only the
 * tiny storage layer so any module can read a variable without importing the admin UI.
 */

const CACHE_MS = 5_000;
let cache: { at: number; vars: Record<string, string> } | null = null;

async function loadVars(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.vars;
  const db = await getDb();
  const doc = await db.collection<any>("bot_settings").findOne({ _id: "singleton" } as any, { projection: { vars: 1 } });
  const vars: Record<string, string> = { ...(doc?.vars ?? {}) };
  cache = { at: Date.now(), vars };
  return vars;
}

/** Drops the in-process cache (tests, and right after a write). */
export function resetAppVarsCache(): void {
  cache = null;
}

/** Value of a panel variable. Falls back to the legacy env variable of the same name (and persists it once). */
export async function getAppVar(key: string): Promise<string | undefined> {
  let vars: Record<string, string>;
  try {
    vars = await loadVars();
  } catch {
    const e = process.env[key]?.trim();
    return e || undefined;
  }
  const v = vars[key];
  if (typeof v === "string" && v.trim() !== "") return v;
  if (Object.prototype.hasOwnProperty.call(vars, key)) return undefined; // explicitly cleared in the panel
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) {
    await setAppVar(key, fromEnv).catch(() => {});
    return fromEnv;
  }
  return undefined;
}

/** Sets (string) or clears (null) a panel variable. Clearing is remembered, so a leftover env value does not come back. */
export async function setAppVar(key: string, value: string | null): Promise<void> {
  const db = await getDb();
  const v = value === null ? "" : String(value);
  await db.collection<any>("bot_settings").updateOne({ _id: "singleton" } as any, { $set: { [`vars.${key}`]: v } }, { upsert: true });
  resetAppVarsCache();
}

/** Every variable currently stored (for the panel screen). */
export async function getAllAppVars(): Promise<Record<string, string>> {
  resetAppVarsCache();
  return { ...(await loadVars()) };
}

/** Numeric helper (chat ids, thresholds). */
export async function getAppVarNumber(key: string): Promise<number | undefined> {
  const raw = await getAppVar(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Well-known keys other modules read (the panel catalog adds the label/group for each). */
export const APP_VAR_KEYS = {
  GAME_SHARE_PHOTO: "GAME_SHARE_PHOTO",
} as const;
