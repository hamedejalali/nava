import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api } from "grammy";
import { env } from "../../src/config/env.js";
import { findExpiredUnnotified, removeQueueEntry } from "../../src/db/models/matchQueue.js";
import { getUser } from "../../src/db/models/user.js";
import { dictionary } from "../../src/i18n/index.js";

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
  if (!env.CRON_SECRET || provided !== `Bearer ${env.CRON_SECRET}`) {
    res.status(401).send("Unauthorized");
    return;
  }

  const api = new Api(env.BOT_TOKEN);
  const expired = await findExpiredUnnotified();

  let notified = 0;
  for (const entry of expired) {
    const user = await getUser(entry._id);
    const lang = user?.languageCode ?? "fa";
    const t = dictionary(lang);

    if (entry.statusMessageId) {
      await api.deleteMessage(entry._id, entry.statusMessageId).catch(() => {});
    }
    await api.sendMessage(entry._id, t.errors.searchTimedOut).catch(() => {});
    await removeQueueEntry(entry._id);
    notified++;
  }

  res.status(200).json({ processed: expired.length, notified });
}
