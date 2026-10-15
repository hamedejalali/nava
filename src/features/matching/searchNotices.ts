import type { NavaContext } from "../../bot-context.js";
import { dictionary, type Language } from "../../i18n/index.js";
import { getUser } from "../../db/models/user.js";
import { claimQueueEntry } from "../../db/models/matchQueue.js";
import {
  claimSearchNotice,
  findDueSearchNotices,
  finishSearchNotice,
  noticeId,
  releaseSearchNotice,
  type SearchNoticeDoc,
} from "../../db/models/searchNotice.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { classifySendError } from "./matchDelivery.js";

type Api = NavaContext["api"];

/** Sends the "search timed out" notice. "sent" also covers "can never be delivered" (blocked the bot). */
export async function sendTimeoutNotice(api: Api, userId: number, lang?: Language): Promise<"sent" | "transient"> {
  const l: Language = lang ?? (await getUser(userId).catch(() => null))?.languageCode ?? "fa";
  try {
    await api.sendMessage(userId, dictionary(l).errors.searchTimedOut, { reply_markup: buildMainMenuReplyKeyboard(l) });
    return "sent";
  } catch (err) {
    return classifySendError(err) === "transient" ? "transient" : "sent";
  }
}

/** Settles a claimed notice after the delivery attempt. */
export async function settleNotice(notice: SearchNoticeDoc, result: "sent" | "transient"): Promise<void> {
  if (result === "sent") await finishSearchNotice(notice._id, "sent");
  else await releaseSearchNotice(notice);
}

/**
 * Recovery pass (cron / opportunistic webhook pass): delivers every timeout notice that is due and was not
 * delivered by the live countdown (the invocation that owned it was cut off, or the queue entry was already
 * removed by MongoDB's TTL). Safe to run repeatedly and concurrently — each notice is claimed atomically.
 * It never touches a NEWER search: ids carry the original search's creation time, and a person who is in a
 * chat or has started another search is simply not notified.
 */
export async function processSearchNotices(api: Api, limit = 25): Promise<{ processed: number; sent: number; skipped: number; retry: number }> {
  const out = { processed: 0, sent: 0, skipped: 0, retry: 0 };
  let due: SearchNoticeDoc[] = [];
  try {
    due = await findDueSearchNotices(limit);
  } catch (err) {
    console.error("[search-notice] lookup failed:", err instanceof Error ? err.name : "unknown");
    return out;
  }
  for (const d of due) {
    try {
      const got = await claimSearchNotice(d.userId, d.queueCreatedAt, { requireDue: true });
      if (got.status !== "claimed") {
        out.skipped++;
        continue;
      }
      out.processed++;
      const notice = got.notice;
      // Remove exactly THIS search's queue entry if it is still there (never a newer one).
      const entry = await claimQueueEntry(notice.userId, { createdBefore: notice.queueCreatedAt, forTimeout: true });
      const user = await getUser(notice.userId).catch(() => null);
      if (user?.activeChatSessionId) {
        // already connected (the match just failed to void this record): nothing to announce
        await finishSearchNotice(notice._id, "void");
        out.skipped++;
        continue;
      }
      const statusId = entry?.statusMessageId ?? notice.statusMessageId;
      if (statusId) await api.deleteMessage(notice.userId, statusId).catch(() => {});
      const res = await sendTimeoutNotice(api, notice.userId, user?.languageCode);
      await settleNotice(notice, res);
      if (res === "sent") out.sent++;
      else out.retry++;
    } catch (err) {
      out.retry++;
      console.error("[search-notice] step failed (will be retried):", err instanceof Error ? err.name : "unknown");
    }
  }
  return out;
}

let lastRun = 0;
/** Webhook-side opportunistic pass, at most every 20 s per warm instance (optimization only). */
export async function maybeProcessSearchNotices(api: Api, minGapMs = 20_000): Promise<void> {
  const now = Date.now();
  if (now - lastRun < minGapMs) return;
  lastRun = now;
  await processSearchNotices(api);
}

export { noticeId };
