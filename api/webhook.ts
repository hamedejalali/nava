import type { VercelRequest, VercelResponse } from "@vercel/node";
import { webhookCallback } from "grammy";
import { createBot } from "../src/bot.js";
import { env } from "../src/config/env.js";

/**
 * The bot instance (and its registered handlers) is created once per
 * cold start and reused across warm invocations of this serverless
 * function — handlers are pure request-time logic with no in-memory
 * application state, so reuse is safe (Vercel Serverless requirement).
 */
const bot = createBot();

const handleUpdate = webhookCallback(bot, "vercel", {
  secretToken: env.WEBHOOK_SECRET,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    // Simple liveness/GET check — never processes updates outside POST.
    res.status(200).send("Nava Bot webhook is alive.");
    return;
  }

  try {
    await handleUpdate(req, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[webhook] Failed to process update:", err);
    // Acknowledge with 200 regardless, so Telegram does not enter an
    // aggressive retry storm for an error we've already logged; the
    // in-handler error boundary (bot.catch in src/bot.ts) already tried to
    // notify the user.
    if (!res.headersSent) {
      res.status(200).send("ok");
    }
  }
}
