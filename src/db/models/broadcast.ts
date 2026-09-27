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
