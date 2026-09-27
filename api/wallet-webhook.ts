import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Update } from "grammy/types";
import { createWalletBot } from "../src/walletBot.js";
import { env } from "../src/config/env.js";

/** Same diagnostics/resilience/HTTP-status pattern as api/webhook.ts — see
 *  the comments there for why a genuine processing failure now returns a
 *  retryable status instead of always 200, and why that's safe now that
 *  the financial operations behind this bot are idempotent. Kept as a
 *  fully separate module/function on purpose: this file never imports
 *  src/bot.ts, and api/webhook.ts never imports src/walletBot.ts, so
 *  Vercel builds and runs them as two independent serverless functions. A
 *  crash constructing the wallet bot cannot break Nava's function (or vice
 *  versa) — they don't share a process, a global scope, or a bundle, only
 *  the same MongoDB and the `users` collection. */

let bot: ReturnType<typeof createWalletBot> | null = null;
let botConstructError: unknown = null;
try {
  bot = createWalletBot();
} catch (err) {
  botConstructError = err;
  console.error("[wallet:webhook] cold-start bot construction failed:", err);
}

let botInitPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!bot) throw botConstructError ?? new Error("wallet bot not constructed");
  if (!botInitPromise) {
    botInitPromise = bot.init().catch((err) => {
      botInitPromise = null;
      throw err;
    });
  }
  await botInitPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send(bot ? "Nava Wallet Bot webhook is alive." : "Nava Wallet Bot webhook is alive but failed to start — check server logs.");
    return;
  }

  // Fail CLOSED. WALLET_WEBHOOK_SECRET is optional in env.ts (so a fresh
  // setup without it doesn't crash), but if it was never configured in
  // this deployment, `secretHeader !== undefined` was FALSE whenever the
  // caller sent no secret header at all — i.e. anyone could POST a fake
  // Telegram update with no secret and it would be accepted. In
  // production, an unconfigured secret is treated as "reject everything"
  // instead of "accept everything". Never logged/echoed anywhere below.
  const configuredSecret = env.WALLET_WEBHOOK_SECRET;
  if (!configuredSecret) {
    if (env.isProduction) {
      console.error("[wallet:webhook] rejected: WALLET_WEBHOOK_SECRET is not configured in production");
      res.status(500).send("server misconfigured");
      return;
    }
    console.error("[wallet:webhook] WARNING: WALLET_WEBHOOK_SECRET is not set — accepting unauthenticated request (non-production only).");
  } else if (req.headers["x-telegram-bot-api-secret-token"] !== configuredSecret) {
    // Not retryable — see api/webhook.ts's comment on the same decision.
    console.error("[wallet:webhook] rejected: bad secret token");
    res.status(401).send("unauthorized");
    return;
  }

  try {
    await ensureInit();
  } catch (err) {
    console.error("[wallet:webhook] bot.init() failed:", err);
    res.status(503).send("bot not ready");
    return;
  }

  try {
    await bot!.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("[wallet:webhook] handleUpdate failed:", err);
    res.status(500).send("processing failed");
    return;
  }

  res.status(200).send("ok");
}
