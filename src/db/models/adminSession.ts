import type { Collection } from "mongodb";
import { getDb } from "../connect.js";
import type { ContentKey } from "./content.js";

/**
 * Tracks "an admin is currently editing content key X and we're waiting for
 * their next text message" — persisted in MongoDB (not in-memory) so it
 * survives across separate serverless invocations, per the project's
 * serverless-state requirement.
 */
export interface AdminSessionDoc {
  _id: number; // admin's Telegram user ID
  editingKey: ContentKey;
  promptMessageId?: number;
  startedAt: Date;
}

async function sessionCollection(): Promise<Collection<AdminSessionDoc>> {
  const db = await getDb();
  return db.collection<AdminSessionDoc>("admin_sessions");
}

export async function startEdit(adminId: number, key: ContentKey, promptMessageId?: number): Promise<void> {
  const col = await sessionCollection();
  await col.updateOne(
    { _id: adminId },
    { $set: { editingKey: key, promptMessageId, startedAt: new Date() } },
    { upsert: true }
  );
}

export async function getEdit(adminId: number): Promise<AdminSessionDoc | null> {
  const col = await sessionCollection();
  return col.findOne({ _id: adminId });
}

export async function clearEdit(adminId: number): Promise<void> {
  const col = await sessionCollection();
  await col.deleteOne({ _id: adminId });
}
