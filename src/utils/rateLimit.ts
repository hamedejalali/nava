import { getDb } from "../db/connect.js";

/**
 * Fixed-window rate limiter backed by MongoDB (never process memory —
 * required for correctness across concurrent Vercel Serverless instances).
 * Each (userId, bucket, window) tuple is one document with an atomic
 * $inc counter and a TTL so old windows clean themselves up automatically.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** True only on the request that FIRST crosses the limit in this
   *  window, so callers can send exactly one warning instead of spamming
   *  the user with a warning on every subsequent blocked request. */
  justExceeded: boolean;
}

export async function checkRateLimit(userId: number, bucket: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const db = await getDb();
  const col = db.collection<{ _id: string; count: number; expiresAt: Date }>("rate_limits");

  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const id = `${userId}:${bucket}:${windowStart}`;

  const doc = await col.findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(windowStart + windowMs * 2) },
    },
    { upsert: true, returnDocument: "after" }
  );

  const count = doc?.count ?? 1;
  return { allowed: count <= limit, justExceeded: count === limit + 1 };
}

export async function ensureRateLimitIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection("rate_limits").createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]);
}

/** Reads the counter of the CURRENT window without counting a new hit (used to block after N failures). */
export async function peekRateLimit(userId: number, bucket: string, windowMs: number): Promise<number> {
  const db = await getDb();
  const col = db.collection<{ _id: string; count: number }>("rate_limits");
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const doc = await col.findOne({ _id: `${userId}:${bucket}:${windowStart}` });
  return doc?.count ?? 0;
}

/**
 * v1.29.8 (audit A-01): per-instance fallback used ONLY when the MongoDB limiter itself throws. It is not shared across serverless
 * instances (so the effective ceiling is limit × warm instances) but it can never be "unlimited", and a limiter outage still does not lock
 * everybody out. Memory is bounded (old windows pruned, hard cap on keys; over the cap new keys are refused = fail closed for newcomers).
 */
const MEM_MAX_KEYS = 5000;
const memHits = new Map<string, number>();
export function memoryRateLimit(userId: number, bucket: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  if (memHits.size > MEM_MAX_KEYS / 2) for (const k of memHits.keys()) if (Number(k.split("|")[2]) < windowStart) memHits.delete(k);
  const id = `${userId}|${bucket}|${windowStart}`;
  if (!memHits.has(id) && memHits.size >= MEM_MAX_KEYS) return { allowed: false, justExceeded: false };
  const count = (memHits.get(id) ?? 0) + 1;
  memHits.set(id, count);
  return { allowed: count <= limit, justExceeded: count === limit + 1 };
}
export function _resetMemoryRateLimit(): void { memHits.clear(); }
