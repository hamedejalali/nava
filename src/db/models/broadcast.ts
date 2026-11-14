import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export interface BroadcastJobDoc {
  _id: string;
  message: string;
  createdBy: number;
  createdAt: Date;
  /** Telegram ID cursor — resume scanning users with _id greater than this. */
  cursorId: number;
  sentCount: number;
  failCount: number;
  done: boolean;
  /** v1.28.0: only ONE worker (admin button / cron) may send at a time. The lease expires by itself if the worker dies. */
  leaseOwner?: string;
  leaseUntil?: Date;
  /** v1.31.0: why sends failed (blocked / deactivated / chat_not_found / other) and whether the ONE final log message was posted */
  failReasons?: Record<string, number>;
  logSent?: boolean;
}

async function col(): Promise<Collection<BroadcastJobDoc>> {
  const db = await getDb();
  return db.collection<BroadcastJobDoc>("broadcast_jobs");
}

export async function createBroadcastJob(message: string, createdBy: number): Promise<BroadcastJobDoc> {
  const doc: BroadcastJobDoc = { _id: randomUUID(), message, createdBy, createdAt: new Date(), cursorId: -1, sentCount: 0, failCount: 0, done: false };
  await (await col()).insertOne(doc);
  return doc;
}

export async function getPendingBroadcastJobs(): Promise<BroadcastJobDoc[]> {
  return (await col()).find({ done: false }).toArray();
}

export async function updateBroadcastProgress(id: string, cursorId: number, sentDelta: number, failDelta: number, done: boolean): Promise<void> {
  await (await col()).updateOne(
    { _id: id },
    { $set: { cursorId, done }, $inc: { sentCount: sentDelta, failCount: failDelta } }
  );
}

export async function getBroadcastJob(id: string): Promise<BroadcastJobDoc | null> {
  return (await col()).findOne({ _id: id });
}


/** Atomically takes the job's lease. Returns the fresh job (with the REAL cursor) or null when somebody else holds a live lease / the job is done. */
export async function claimBroadcastLease(id: string, owner: string, ttlMs: number): Promise<BroadcastJobDoc | null> {
  const now = new Date();
  return (await col()).findOneAndUpdate(
    { _id: id, done: false, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }, { leaseOwner: owner }] },
    { $set: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + ttlMs) } },
    { returnDocument: "after" },
  );
}

/** Compare-and-set progress: applies only while `owner` still holds the lease AND the stored cursor is `fromCursor`.
 *  A worker whose lease was taken over (stale) therefore can never move the cursor or double count. */
export async function advanceBroadcast(id: string, owner: string, fromCursor: number, toCursor: number, sentDelta: number, failDelta: number, done: boolean, ttlMs: number): Promise<boolean> {
  const r = await (await col()).updateOne(
    { _id: id, leaseOwner: owner, cursorId: fromCursor, done: false },
    { $set: { cursorId: toCursor, done, leaseUntil: new Date(Date.now() + ttlMs) }, $inc: { sentCount: sentDelta, failCount: failDelta } },
  );
  return r.modifiedCount === 1;
}

export async function releaseBroadcastLease(id: string, owner: string): Promise<void> {
  await (await col()).updateOne({ _id: id, leaseOwner: owner }, { $unset: { leaseOwner: "", leaseUntil: "" } });
}

export async function addBroadcastFailReason(id: string, reason: string): Promise<void> {
  await (await col()).updateOne({ _id: id }, { $inc: { [`failReasons.${reason}`]: 1 } });
}

/** Claims the right to post the single final log message (exactly once, even with two workers). */
export async function claimBroadcastLog(id: string): Promise<BroadcastJobDoc | null> {
  return (await col()).findOneAndUpdate({ _id: id, done: true, logSent: { $ne: true } }, { $set: { logSent: true } }, { returnDocument: "after" });
}
export async function unclaimBroadcastLog(id: string): Promise<void> {
  await (await col()).updateOne({ _id: id }, { $set: { logSent: false } });
}
