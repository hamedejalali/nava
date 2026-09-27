import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Update } from "grammy/types";
import { createBot } from "../src/bot.js";
import { env } from "../src/config/env.js";

// grammY's `webhookCallback` framework adapters don't include one that
// matches Vercel's Node.js request/response shape, so we drive
// `bot.handleUpdate` directly instead.

/**
 * DIAGNOSTICS: every branch below logs a short, clearly-labeled line
 * (never a token/secret/URI value) so a webhook outage shows up
 * immediately in Vercel's Runtime Logs for `api/webhook`, and so it is
 * obvious WHICH stage failed:
 *   [nava:webhook] cold-start bot construction failed
 *   [nava:webhook] rejected: bad secret token
 *   [nava:webhook] bot.init() failed
 *   [nava:webhook] handleUpdate failed
 * If Nava ever "goes silent" again: check these four prefixes first, or
 * just look at `pending_update_count` / `last_error_message` from
 * `npm run webhook-info` — see the HTTP status note below for why that
 * now actually means something.
 */

let bot: ReturnType<typeof createBot> | null = null;
let botConstructError: unknown = null;
try {
  bot = createBot();
} catch (err) {
  // A missing/invalid BOT_TOKEN (or any other error thrown while wiring up
  // features) used to crash this whole module at import time with a
  // generic Vercel "function crashed" error. Catching it here means every
  // request instead gets ONE clear, labeled log line explaining why.
  botConstructError = err;
  console.error("[nava:webhook] cold-start bot construction failed:", err);
}

// FIXED — this promise used to be cached forever once set, even if it
// REJECTED. A single transient failure of bot.init() (e.g. a brief
// Telegram API hiccup while fetching bot info on cold start) would poison
// every following request on this warm container: `botInitPromise` stayed
// set to the same rejected promise, so every subsequent request re-awaited
// (and immediately re-threw) that exact same old error, forever, until
// Vercel eventually recycled the instance. Now a failure clears the cache
// so the next request tries again.
let botInitPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!bot) throw botConstructError ?? new Error("bot not constructed");
  if (!botInitPromise) {
    botInitPromise = bot.init().catch((err) => {
      botInitPromise = null; // let the next request retry instead of replaying this failure forever
      throw err;
    });
  }
  await botInitPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send(bot ? "Nava Bot webhook is alive." : "Nava Bot webhook is alive but failed to start — check server logs.");
    return;
  }

  let secretOk: boolean;
  try {
    secretOk = req.headers["x-telegram-bot-api-secret-token"] === env.WEBHOOK_SECRET;
  } catch (err) {
    // env.WEBHOOK_SECRET is a required() getter — this only throws if the
    // env var is genuinely missing in this deployment.
    console.error("[nava:webhook] cannot read WEBHOOK_SECRET (missing env var?):", err);
    res.status(500).send("server misconfigured");
    return;
  }

  if (!secretOk) {
    // Intentionally NOT retryable: the secret will never become correct on
    // its own, so there is nothing to gain from Telegram retrying this
    // request, and a 401 makes a misconfigured/rotated secret loud and
    // immediate instead of silently retried forever.
    console.error("[nava:webhook] rejected: bad secret token");
    res.status(401).send("unauthorized");
    return;
  }

  // FIXED — HTTP status on a genuine processing failure (v1.4.0). This used
  // to always answer Telegram with 200 even when `ensureInit()` or
  // `handleUpdate()` threw. Telegram treats HTTP 200 as "delivered
  // successfully" and will NOT retry that update — so a transient failure
  // (a momentary MongoDB hiccup, a brief Telegram API error while
  // fetching something mid-update, ...) silently dropped that one user
  // action forever, AND made `getWebhookInfo`'s `pending_update_count` /
  // `last_error_message` useless as a diagnostic (Telegram genuinely
  // believed nothing was wrong).
  //
  // This is now safe to change because the financial/reward operations
  // Telegram might retry are all idempotent (deterministic ledger ids,
  // the mining `batchId`, the transfer `clientRequestId` — see
  // src/db/models/relic.ts and src/db/models/walletMining.ts): a genuine
  // Telegram retry of the same update re-running the same handler again
  // cannot double-charge or double-credit anyone. A response other than
  // 200 tells Telegram to retry with backoff; if the same update keeps
  // failing forever (a real bug, not a transient blip), Telegram's own
  // backoff/give-up behavior bounds the cost — we deliberately do not add
  // our own retry-counting on top of that.
  try {
    await ensureInit();
  } catch (err) {
    console.error("[nava:webhook] bot.init() failed:", err);
    res.status(503).send("bot not ready");
    return;
  }

  try {
    await bot!.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("[nava:webhook] handleUpdate failed:", err);
    res.status(500).send("processing failed");
    return;
  }

  res.status(200).send("ok");
}
