import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export type PhotoModerationStatus = "delivered" | "deleted" | "sender_banned";

/**
 * Log of photos sent inside an active anonymous chat. Unlike the old
 * "image_moderation" chat_image flow, a photo is now ALWAYS delivered to
 * the recipient immediately — this collection is purely a moderation
 * audit/log trail (with admin "Delete"/"Ban Sender" actions), never a
 * delivery gate. TTL-bounded metadata only; no file is stored by us beyond
 * Telegram's own file_id (which Telegram itself expires/evicts on its own
 * schedule) — we keep no separate copy of the image.
 */
export interface PhotoModerationDoc {
  _id: string;
  senderTelegramId: number;
  receiverTelegramId: number;
  /** message_id of the sender's own original message (for alerting them). */
  senderMessageId: number;
  /** message_id of the copy delivered to the recipient (for best-effort delete). */
  receiverMessageId: number;
  chatSessionId: string;
  fileId: string;
  status: PhotoModerationStatus;
  /** Result of the real AI check (Sightengine) — informational only, never
   *  gates delivery. Absent if the AI service call itself failed. */
  aiFlagged?: boolean;
  aiScore?: number;
  aiClassification?: string;
  createdAt: Date;
  decidedAt?: Date;
  decidedBy?: number;
}

async function col(): Promise<Collection<PhotoModerationDoc>> {
  const db = await getDb();
  return db.collection<PhotoModerationDoc>("photo_moderation_log");
}

export async function ensurePhotoModerationLogIndexes(): Promise<void> {
  const c = await col();
  // 14-day TTL — long enough for any realistic admin review window, short
  // enough to respect "no permanent chat-content storage".
  await c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
}

export async function createPhotoModerationLog(input: {
  senderTelegramId: number;
  receiverTelegramId: number;
  senderMessageId: number;
  receiverMessageId: number;
  chatSessionId: string;
  fileId: string;
  aiFlagged?: boolean;
  aiScore?: number;
  aiClassification?: string;
}): Promise<PhotoModerationDoc> {
  const doc: PhotoModerationDoc = {
    _id: randomUUID(),
    status: "delivered",
    createdAt: new Date(),
    ...input,
  };
  await (await col()).insertOne(doc);
  return doc;
}

export async function getPhotoModerationLog(id: string): Promise<PhotoModerationDoc | null> {
  return (await col()).findOne({ _id: id });
}

export type DecideResult = { status: "decided"; doc: PhotoModerationDoc } | { status: "already_decided"; doc: PhotoModerationDoc } | { status: "not_found" };

/**
 * Atomically marks a log entry as decided — the filter excludes the TARGET
 * status so, e.g., two concurrent "Delete" taps on the same message can
 * only actually delete once (the second is a safe, idempotent no-op that
 * reports "already_decided" instead of re-attempting the Telegram delete
 * call / re-sending the sender warning).
 */
export async function markPhotoModerationDecided(
  id: string,
  status: Exclude<PhotoModerationStatus, "delivered">,
  decidedBy: number
): Promise<DecideResult> {
  const c = await col();
  const updated = await c.findOneAndUpdate(
    { _id: id, status: { $ne: status } },
    { $set: { status, decidedAt: new Date(), decidedBy } },
    { returnDocument: "after" }
  );
  if (updated) return { status: "decided", doc: updated };

  const existing = await c.findOne({ _id: id });
  if (!existing) return { status: "not_found" };
  return { status: "already_decided", doc: existing };
}
