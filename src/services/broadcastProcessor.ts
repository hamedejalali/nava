import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { getPendingBroadcastJobs, updateBroadcastProgress, type BroadcastJobDoc } from "../db/models/broadcast.js";

const BATCH_SIZE = 40; // stays well inside a single serverless invocation's time budget

/** Sends the broadcast to the next BATCH_SIZE users after the job's
 *  cursor, then advances (or completes) the job. Safe to call repeatedly
 *  (by the admin action AND by the cron job) — a completed job is a no-op. */
export async function processBroadcastBatch(api: Api, job: BroadcastJobDoc): Promise<void> {
  if (job.done) return;

  const db = await getDb();
  const users = await db
    .collection<any>("users")
    .find({ _id: { $gt: job.cursorId }, banned: { $ne: true } })
    .sort({ _id: 1 })
    .limit(BATCH_SIZE)
    .project({ _id: 1 })
    .toArray();

  if (users.length === 0) {
    await updateBroadcastProgress(job._id, job.cursorId, 0, 0, true);
    return;
  }

  let sent = 0;
  let failed = 0;
  let lastId = job.cursorId;

  for (const u of users) {
    lastId = u._id;
    try {
      await api.sendMessage(u._id, job.message);
      sent++;
    } catch {
      failed++;
    }
  }

  const isLastBatch = users.length < BATCH_SIZE;
  await updateBroadcastProgress(job._id, lastId, sent, failed, isLastBatch);
}

export async function processAllPendingOneBatchEach(api: Api): Promise<void> {
  const jobs = await getPendingBroadcastJobs();
  for (const job of jobs) {
    await processBroadcastBatch(api, job);
  }
}
