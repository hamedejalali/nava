/**
 * v1.29.6 (F-03 / F-15) — structured, privacy-safe error logging.
 *
 * Raw error objects are never printed: a grammY `GrammyError` carries the request parameters (user text, ids), a MongoDB error can carry
 * host names, a fetch error can carry a URL. `logError` prints ONLY: a stable error code, a static description written by us, and the
 * error's class name plus a short machine code / HTTP status (e.g. `GrammyError[403]`, `MongoServerSelectionError`). Never the message,
 * stack, payload or cause. One line per event, greppable by code in the Vercel logs (docs/ERROR_CODES.md lists them).
 */
export const ERROR_CODES = {
  "MG-DB-001": "MongoDB connection attempt failed",
  "MG-DB-002": "MongoDB ping failed (health)",
  "MG-WH-001": "webhook cold-start bot construction failed",
  "MG-WH-002": "webhook secret unreadable",
  "MG-WH-003": "bot.init() failed",
  "MG-BOT-001": "bot index setup failed",
  "MG-MA-001": "Mini App index setup failed",
  "MG-VF-001": "verify sample photo could not be sent",
  "MG-VF-002": "verify notification photo failed",
  "MG-CR-001": "chat request could not be delivered",
  "MG-PR-001": "profile photo could not be sent",
  "MG-PR-002": "profile reveal notification failed",
  "MG-AD-001": "admin channel getChat failed",
  "MG-BK-001": "backup DM to admin failed",
  "MG-BK-002": "backup to channel failed",
  "MG-BK-003": "export failed",
  "MG-BK-004": "import failed",
  "MG-RG-001": "reaction gate check failed (user let through)",
  "MG-IN-001": "invite banner photo could not be sent",
  "MG-AGE-001": "age-band re-check of a running chat failed",
  "MG-WL-001": "wallet deposit receipt to the log chat failed (will retry)",
  "MG-RL-001": "Mini App rate limiter unavailable (in-memory fallback used)",
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

/** class name + short code/status only — never message, stack, params or cause */
export function errInfo(err: unknown): string {
  if (err === null || err === undefined) return "unknown";
  if (typeof err !== "object") return "non-error";
  const e = err as { name?: unknown; code?: unknown; error_code?: unknown; status?: unknown };
  const name = typeof e.name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(e.name) ? e.name : "Error";
  const raw = e.error_code ?? e.status ?? e.code;
  const code = typeof raw === "number" || (typeof raw === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(raw)) ? String(raw) : "";
  return code ? `${name}[${code}]` : name;
}

export function logError(code: ErrorCode, description: string, err?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${code}] ${description}${err === undefined ? "" : ` :: ${errInfo(err)}`}`);
}
