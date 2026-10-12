import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../src/db/connect.js";
import { env } from "../src/config/env.js";

/**
 * Lightweight, PUBLIC diagnostic endpoint — GET /api/health.
 *
 * Exposes ONLY booleans and timings, never a value: not a token, not a
 * URI, not a secret, not which specific env var (beyond its name) is set.
 * Safe to leave public and to check from a phone browser when trying to
 * figure out why a bot went quiet.
 *
 * FIXED (v1.4.0): the MongoDB failure branch used to put the raw error's
 * `.message` straight into the public JSON response. Depending on the
 * failure, that message can include internal infrastructure details (a
 * hostname, a driver-internal error string, sometimes fragments that hint
 * at the connection configuration) — not a secret, but more than a public,
 * unauthenticated endpoint should ever hand out. The full error (message
 * AND stack) is still logged to Vercel's server-side console exactly as
 * before; the public response now only ever says "unreachable".
 *
 * This does NOT tell you whether Telegram's webhook is correctly pointed
 * at this deployment — for that, run `npm run webhook-info` locally (it calls Telegram directly).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const envPresence = {
    BOT_TOKEN: !!process.env.BOT_TOKEN,
    WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
    MONGODB_URI: !!process.env.MONGODB_URI,
  };

  let mongo: { reachable: boolean; ms: number | null } = { reachable: false, ms: null };
  const start = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    mongo = { reachable: true, ms: Date.now() - start };
  } catch (err) {
    mongo = { reachable: false, ms: Date.now() - start };
    // Full detail (message + stack) goes to Vercel's server-side logs
    // only — never into the public response below.
    console.error("[health] MongoDB ping failed:", err);
  }

  const ok = envPresence.BOT_TOKEN && envPresence.WEBHOOK_SECRET && envPresence.MONGODB_URI && mongo.reachable;

  res.status(ok ? 200 : 503).json({
    ok,
    time: new Date().toISOString(),
    env: envPresence,
    mongo: { reachable: mongo.reachable, ms: mongo.ms, ...(mongo.reachable || env.isProduction ? {} : { hint: "check server logs for the full error" }) },
  });
}
