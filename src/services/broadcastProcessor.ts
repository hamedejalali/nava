import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { getDb } from "../db/connect.js";
import { advanceBroadcast, claimBroadcastLease, getPendingBroadcastJobs, releaseBroadcastLease, type BroadcastJobDoc } from "../db/models/broadcast.js";

const BATCH_SIZE = 40;
const LEASE_MS = 90_000; // longer than any single user send; renewed with every checkpoint
/** pacing between sends (Telegram allows ≈30 messages/second to different chats). Tests set it to 0. */
export const BROADCAST_PACE = { ms: 40 };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

type SendKind = "ok" | "gone" | "retry";
/** 403 (blocked) / 400 (chat not found, deactivated) = this user will never get it → count as failed and move on.
 *  429 / 5xx / network = transient → STOP, do not advance past this user (the next run retries him). */
function classify(err: unknown): SendKind {
  const code = (err as { error_code?: number })?.error_code;
  if (code === 403 || code === 400) return "gone";
  return "retry";
}

/** Sends the broadcast to users after the job's cursor for up to `budgetMs`, in lease-protected batches.
 *  Two workers can never send the same batch: the lease is claimed atomically and every checkpoint is a compare-and-set
 *  on (owner, cursor). The cursor is saved after EVERY user, so a crash can repeat at most the one message in flight.
 *  Safe to call repeatedly from the admin action AND the cron job — a done / leased job is a no-op. */
export async function processBroadcastBatch(api: Api, job: BroadcastJobDoc, opts: { budgetMs?: number } = {}): Promise<void> {
  const owner = randomUUID();
  const claimed = await claimBroadcastLease(job._id, owner, LEASE_MS);
  if (!claimed) return;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  let cursor = claimed.cursorId;
  try {
    const db = await getDb();
    for (;;) {
      const users = await db
        .collection<any>("users")
        .find({ _id: { $gt: cursor }, banned: { $ne: true }, isSeed: { $ne: true } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .project({ _id: 1 })
        .toArray();
      if (users.length === 0) {
        await advanceBroadcast(job._id, owner, cursor, cursor, 0, 0, true, LEASE_MS);
        return;
      }
      for (const u of users) {
        let kind: SendKind;
        try {
          await api.sendMessage(u._id, claimed.message);
          kind = "ok";
        } catch (err) {
          kind = classify(err);
        }
        if (kind === "retry") return; // transient: leave the cursor BEFORE this user
        const moved = await advanceBroadcast(job._id, owner, cursor, u._id, kind === "ok" ? 1 : 0, kind === "gone" ? 1 : 0, false, LEASE_MS);
        if (!moved) return; // lease lost to another worker: stop immediately, never double count
        cursor = u._id;
        if (Date.now() > deadline) return;
        await sleep(BROADCAST_PACE.ms);
      }
      if (users.length < BATCH_SIZE) {
        await advanceBroadcast(job._id, owner, cursor, cursor, 0, 0, true, LEASE_MS);
        return;
      }
      if (Date.now() > deadline) return;
    }
  } finally {
    await releaseBroadcastLease(job._id, owner).catch(() => {});
  }
}

export async function processAllPendingOneBatchEach(api: Api, opts: { budgetMs?: number } = {}): Promise<void> {
  const jobs = await getPendingBroadcastJobs();
  const budget = opts.budgetMs ?? 45_000;
  const t0 = Date.now();
  for (const job of jobs) {
    const left = budget - (Date.now() - t0);
    if (left <= 0) break;
    await processBroadcastBatch(api, job, { budgetMs: left });
  }
}
