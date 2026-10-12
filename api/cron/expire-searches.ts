import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api, GrammyError } from "grammy";
import { env } from "../../src/config/env.js";
import { safeEqual } from "../../src/utils/secureCompare.js";
import { findExpiredUnnotified, leaseExpiredQueueEntry, finishExpiredQueueEntry } from "../../src/db/models/matchQueue.js";
import { getUser } from "../../src/db/models/user.js";
import { dictionary } from "../../src/i18n/index.js";
import { maybeRunAlertCheck, defaultSend } from "../../src/services/monitor.js";
import { cleanupStories } from "../../src/services/nava/stories.js";

/**
 * MongoDB's TTL index eventually deletes expired match_queue documents on
 * its own, but that cleanup is silent — it never tells the WAITING USER
 * their search timed out. This endpoint closes that gap: it runs on a
 * schedule (see vercel.json "crons"), finds entries past their deadline
 * that haven't been notified yet, deletes their status message, sends a
 * "search timed out" notice, and removes the queue entry immediately
 * (rather than waiting for the TTL sweep).
 *
 * IMPORTANT (Vercel plan limitation): Vercel's Hobby plan only allows cron
 * jobs to run once per day, which is far too infrequent for a 2-minute
 * search timeout to feel real-time. On Hobby, either upgrade to Pro (which
 * allows per-minute schedules), or trigger this endpoint yourself every
 * 1-2 minutes from an external scheduler (e.g. a free uptime-monitoring
 * service) hitting this URL with the CRON_SECRET below. See README.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || !safeEqual(provided, `Bearer ${env.CRON_SECRET}`)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const api = new Api(env.BOT_TOKEN);
  const result = await processExpiredSearches(api);

  // Backstop alert evaluation (never throws); covers quiet periods with no webhook traffic.
  await maybeRunAlertCheck({ send: defaultSend });

  // Navagram housekeeping: drops stories older than the 30-day archive (never throws).
  let storiesDropped = 0;
  try {
    storiesDropped = await cleanupStories();
  } catch (err) {
    console.error("[cron] story cleanup failed:", err instanceof Error ? err.name : "unknown");
  }

  res.status(200).json({ ...result, storiesDropped });
}

/** A Telegram error that retrying can never fix (user blocked the bot, chat gone, bad request). */
function isPermanentTelegramError(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code >= 400 && err.error_code < 500 && err.error_code !== 429;
}

/**
 * Delivers the "search timed out" notice for expired queue entries.
 *  - every entry is first LEASED atomically (exact createdAt/expiresAt), so concurrent cron runs and the
 *    in-process countdown never both notify, and a user who started a NEW search meanwhile is left alone;
 *  - the entry is removed (exactly that document) only after the notice was delivered or can never be
 *    delivered; a transient failure leaves it in place with an expiring lease, so the next run retries;
 *  - one failing entry never stops the others.
 * (MongoDB's TTL index may still remove an expired entry before this runs; the live countdown inside the
 * webhook invocation is the primary path, this is the recovery backstop.)
 */
export async function processExpiredSearches(api: Pick<Api, "deleteMessage" | "sendMessage">) {
  const expired = await findExpiredUnnotified();
  let notified = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of expired) {
    try {
      const leased = await leaseExpiredQueueEntry(entry);
      if (!leased) {
        skipped++; // someone else owns it, or it changed/was removed meanwhile
        continue;
      }
      const user = await getUser(entry._id);
      const t = dictionary(user?.languageCode ?? "fa");

      if (leased.statusMessageId) {
        await api.deleteMessage(entry._id, leased.statusMessageId).catch(() => {});
      }
      let delivered = false;
      try {
        await api.sendMessage(entry._id, t.errors.searchTimedOut);
        delivered = true;
      } catch (err) {
        if (!isPermanentTelegramError(err)) {
          failed++; // transient: keep the entry (lease expires) so the next run retries
          console.error("[cron] timeout notice failed, will retry:", err instanceof Error ? err.name : "unknown");
          continue;
        }
      }
      await finishExpiredQueueEntry(leased);
      if (delivered) notified++;
    } catch (err) {
      failed++;
      console.error("[cron] expire-searches entry failed:", err instanceof Error ? err.name : "unknown");
    }
  }
  return { processed: expired.length, notified, skipped, failed };
}
