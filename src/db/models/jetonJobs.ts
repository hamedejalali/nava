import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

/**
 * v1.29.0 — bulk jeton sends from the owner's «🪙 مدیریت ژتون» panel.
 *
 * A job is a durable, resumable unit (same idea as broadcast_jobs): who gets it (`mode` + `params`), how much, which message(s)
 * follow, a cursor over the matching users, counters and a lease so only ONE worker (button / cron) works on it at a time.
 * The credit for every person is a ledger row with the deterministic id `jetonmass:<jobId>:<userId>`, so even if a worker dies
 * and the job is resumed, nobody is ever credited twice.
 */
export type JetonMode = "inactive" | "gender" | "users";

export interface JetonJobDoc {
  _id: string;
  createdBy: number;
  createdAt: Date;
  mode: JetonMode;
  /** inactive: fixed cutoff taken when the job was created; gender: "male" | "female"; users: explicit numeric ids */
  params: { cutoff?: Date; days?: number; gender?: "male" | "female"; ids?: number[] };
  /** jeton per person */
  amount: number;
  /** 0, 1 or 2 plain-text messages sent (in this order) after the credit. Nothing else is ever sent to the person. */
  messages: string[];
  /** how many people matched when the owner confirmed (information only) */
  matched: number;
  cursorId: number;
  /** people credited by THIS job (each exactly once) */
  credited: number;
  /** people who received the message(s) */
  delivered: number;
  /** people who could not receive the message (blocked the bot…) — their jeton was still credited */
  undelivered: number;
  done: boolean;
  /** the single summary message for the log channel is sent once */
  logSent?: boolean;
  leaseOwner?: string;
  leaseUntil?: Date;
}

async function col(): Promise<Collection<JetonJobDoc>> {
  return (await getDb()).collection<JetonJobDoc>("jeton_jobs");
}

export async function createJetonJob(input: Pick<JetonJobDoc, "createdBy" | "mode" | "params" | "amount" | "messages" | "matched">): Promise<JetonJobDoc> {
  const doc: JetonJobDoc = { _id: randomUUID(), createdAt: new Date(), cursorId: -1, credited: 0, delivered: 0, undelivered: 0, done: false, ...input };
  await (await col()).insertOne(doc);
  return doc;
}

export async function getJetonJob(id: string): Promise<JetonJobDoc | null> {
  return (await col()).findOne({ _id: id });
}

export async function getPendingJetonJobs(): Promise<JetonJobDoc[]> {
  return (await col()).find({ done: false }).toArray();
}

export async function claimJetonLease(id: string, owner: string, ttlMs: number): Promise<JetonJobDoc | null> {
  const now = new Date();
  return (await col()).findOneAndUpdate(
    { _id: id, done: false, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }, { leaseOwner: owner }] },
    { $set: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + ttlMs) } },
    { returnDocument: "after" },
  );
}

/** Compare-and-set progress: applies only while `owner` holds the lease AND the stored cursor is `fromCursor`. */
export async function advanceJetonJob(
  id: string,
  owner: string,
  fromCursor: number,
  toCursor: number,
  d: { credited: number; delivered: number; undelivered: number },
  done: boolean,
  ttlMs: number,
): Promise<boolean> {
  const r = await (await col()).updateOne(
    { _id: id, leaseOwner: owner, cursorId: fromCursor, done: false },
    { $set: { cursorId: toCursor, done, leaseUntil: new Date(Date.now() + ttlMs) }, $inc: { credited: d.credited, delivered: d.delivered, undelivered: d.undelivered } },
  );
  return r.modifiedCount === 1;
}

export async function releaseJetonLease(id: string, owner: string): Promise<void> {
  await (await col()).updateOne({ _id: id, leaseOwner: owner }, { $unset: { leaseOwner: "", leaseUntil: "" } });
}

/** Atomically claims the right to send the one summary log message (true only for the first caller). */
export async function claimJetonLog(id: string): Promise<JetonJobDoc | null> {
  return (await col()).findOneAndUpdate({ _id: id, done: true, logSent: { $ne: true } }, { $set: { logSent: true } }, { returnDocument: "after" });
}
