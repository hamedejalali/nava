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