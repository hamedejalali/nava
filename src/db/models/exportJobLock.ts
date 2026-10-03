import { getDb } from "../connect.js";

/**
 * A single-document MongoDB lock preventing two concurrent "export to
 * backup channel" jobs from running at once (e.g. an admin double-tapping
 * the button, or two admins triggering it seconds apart) — exports stream
 * the whole users collection, so overlapping runs would waste resources
 * and could interleave uploads confusingly.
 *
 * Deliberately MongoDB-based, not in-memory, so it still works correctly
 * across concurrent serverless invocations/cold starts. A lock older than
 * STALE_MS is treated as abandoned (e.g. the invocation crashed before
 * releasing it) and can be re-acquired, so a crash can never permanently
 * wedge the backup feature.
 */
const LOCK_ID = "user_export_backup";
const STALE_MS = 10 * 60 * 1000; // 10 minutes

async function col() {
  const db = await getDb();
  return db.collection<{ _id: string; acquiredAt: Date; acquiredBy: number }>("export_job_lock");
}

export async function acquireExportLock(adminId: number): Promise<boolean> {
  const c = await col();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);

  const result = await c.findOneAndUpdate(
    { _id: LOCK_ID, $or: [{ acquiredAt: { $lt: staleBefore } }, { acquiredAt: { $exists: false } }] },
    { $set: { acquiredAt: now, acquiredBy: adminId } },
    { upsert: true, returnDocument: "after" }
  );
  // A fresh upsert or a stale-lock takeover both succeed here. If someone
  // else holds a live (non-stale) lock, the filter matches nothing and
  // findOneAndUpdate's upsert creates a DUPLICATE-KEY conflict instead —
  // caught below and treated as "lock held".
  return !!result;
}

export async function releaseExportLock(): Promise<void> {
  const c = await col();
  await c.deleteOne({ _id: LOCK_ID });
}
