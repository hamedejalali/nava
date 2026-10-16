import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Update } from "grammy/types";
import { createBot } from "../src/bot.js";
import { waitUntil } from "@vercel/functions";
import { env } from "../src/config/env.js";
import { safeEqual } from "../src/utils/secureCompare.js";
import { processUpdateOnce } from "../src/webhook/processUpdate.js";
import { maybeProcessSearchNotices } from "../src/features/matching/searchNotices.js";
import { maybeProcessDueGiftEvents } from "../src/services/nava/giftEvents.js";
import { maybeProcessDueDeliveries } from "../src/features/matching/matchDelivery.js";
import { recordWebhookMetric, maybeRunAlertCheck, defaultSend } from "../src/services/monitor.js";

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

/** Best-effort notice to the person whose update could not be processed after all attempts. */
async function notifyDeadUpdate(update: Update): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.from.id;
  if (!chatId || !bot) return;
  await bot.api.sendMessage(chatId, "⚠️ مشکلی پیش اومد و درخواستت انجام نشد. لطفاً دوباره امتحان کن.");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send(bot ? "Nava Bot webhook is alive." : "Nava Bot webhook is alive but failed to start — check server logs.");
    return;
  }

  let secretOk: boolean;
  try {
    secretOk = safeEqual(req.headers["x-telegram-bot-api-secret-token"], env.WEBHOOK_SECRET);
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

  // Failure strategy (v1.16.3, see src/webhook/processUpdate.ts):
  //   200 = processed, a harmless duplicate of an already-processed update, or deliberately parked
  //         (dead-letter) after the bounded number of attempts;
  //   5xx = NOT done — Telegram redelivers with backoff (init failure 503, handler failure 500,
  //         concurrent duplicate 500, inbox database unavailable 503).
  // Money-moving operations are idempotent (deterministic ledger ids), so a redelivery can never double-apply.
  try {
    await ensureInit();
  } catch (err) {
    console.error("[nava:webhook] bot.init() failed:", err);
    res.status(503).send("bot not ready");
    return;
  }

  const startedAt = Date.now();
  const update = req.body as Update;
  // Idempotent inbox (see src/webhook/processUpdate.ts): 200 = processed or deliberately parked, 5xx = please redeliver.
  const result = await processUpdateOnce(update, (u) => bot!.handleUpdate(u), { onDead: notifyDeadUpdate });
  if (result.http !== 200) {
    console.error(`[nava:webhook] update not completed (${result.outcome})`);
    waitUntil(recordWebhookMetric(false, Date.now() - startedAt).then(() => maybeRunAlertCheck({ send: defaultSend })));
    res.status(result.http).send(result.outcome === "inbox_unavailable" ? "inbox unavailable" : "processing failed");
    return;
  }

  waitUntil(recordWebhookMetric(result.outcome !== "dead_letter", Date.now() - startedAt).then(() => maybeRunAlertCheck({ send: defaultSend })));
  waitUntil(maybeProcessDueDeliveries(bot!.api).catch(() => {}));
  waitUntil(maybeProcessSearchNotices(bot!.api).catch(() => {}));
  waitUntil(maybeProcessDueGiftEvents(bot!.api).catch(() => {}));
  res.status(200).send("ok");
}
