import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api } from "grammy";
import { env } from "../src/config/env.js";
import { TELEGRAM_API_TIMEOUT_S } from "../src/utils/fetchTimeout.js";
import { verifyQStash, type SearchStepPayload } from "../src/services/qstash.js";
import { runSearchStep } from "../src/features/matching/searchSteps.js";
import { seedGuardTransformer } from "../src/services/seeds/guard.js";
import { telegramSafetyTransformer } from "../src/ui/telegramSafety.js";
import { loadOverrides } from "../src/db/models/uiOverrides.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as any) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length;
    if (size > 16_384) throw new Error("too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** v1.33.0 — one QStash-driven step of a 40 s search (see features/matching/searchSteps.ts). Signed by QStash; short; idempotent. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return void res.status(405).send("Method Not Allowed");
  let body: string;
  try {
    body = await rawBody(req);
  } catch {
    return void res.status(413).send("Payload Too Large");
  }
  if (!(await verifyQStash(req.headers["upstash-signature"] as string | undefined, body))) return void res.status(401).send("Invalid signature");
  let p: SearchStepPayload;
  try {
    p = JSON.parse(body);
  } catch {
    return void res.status(400).send("Bad Request");
  }
  if (!p || !["scan", "seed", "expire"].includes(p.kind) || typeof p.userId !== "number" || typeof p.createdAt !== "number") return void res.status(400).send("Bad Request");
  try {
    await loadOverrides();
    const api = new Api(env.BOT_TOKEN, { timeoutSeconds: TELEGRAM_API_TIMEOUT_S.cron });
    api.config.use(telegramSafetyTransformer);
    api.config.use(seedGuardTransformer);
    await runSearchStep(api as any, p);
    res.status(200).send("OK");
  } catch (err) {
    // 5xx → QStash retries (the steps are idempotent, and the daily cron + durable notices remain the last backstop)
    console.error("[search-step] failed:", err instanceof Error ? err.name : "unknown");
    res.status(503).send("retry");
  }
}
