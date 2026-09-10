import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Update } from "grammy/types";
import { createBot } from "../src/bot.js";
import { env } from "../src/config/env.js";

const bot = createBot();

// grammY's `webhookCallback` framework adapters don't include one that
// matches Vercel's Node.js request/response shape, so we drive
// `bot.handleUpdate` directly instead.
let botInitPromise: Promise<void> | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send("Nava Bot webhook is alive.");
    return;
  }

  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== env.WEBHOOK_SECRET) {
    // Temporary diagnostic logging (lengths only, never the actual secret
    // values) to debug a secret-token mismatch during initial setup.
    console.error("[webhook] secret mismatch", {
      headerType: typeof secretHeader,
      headerLength: typeof secretHeader === "string" ? secretHeader.length : null,
      envLength: env.WEBHOOK_SECRET.length,
      headerPresent: secretHeader !== undefined,
    });
    res.status(401).send("unauthorized");
    return;
  }

  try {
    if (!botInitPromise) botInitPromise = bot.init();
    await botInitPromise;
    await bot.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("[webhook] Failed to process update:", err);
  }

  if (!res.headersSent) {
    res.status(200).send("ok");
  }
}