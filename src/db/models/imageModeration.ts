import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export type ModerationType = "profile_photo" | "chat_image";
export type ModerationStatus = "pending" | "approved" | "rejected" | "superseded";

export interface ImageModerationDoc {
  _id: string;
  type: ModerationType;
  senderId: number;
  /** Only set for type "chat_image". */
  recipientId?: number;
  chatSessionId?: string;
  fileId: string;
  status: ModerationStatus;
  /** From the AI moderation service (e.g. Sightengine) — undefined if the
   *  service call failed and we fell back to manual review. */
  aiScore?: number;
  aiClassification?: string;
  createdAt: Date;
  reviewedAt?: Date;
  reviewingAdmin?: number;
}

async function col(): Promise<Collection<ImageModerationDoc>> {
  const db = await getDb();
  return db.collection<ImageModerationDoc>("image_moderation");
}

// FIXED (v1.4.0, audit): `senderId_1`/`status_1` used to be created here,
// but every current lookup (approve/reject from the admin's inline button)
// goes through `findOne({ _id })` — the doc's own id, carried in the
// callback data — never a filter on senderId or status alone. These two
// indexes did write work on every photo upload for no current query
// benefit. If an admin "list all pending moderation items" screen is ever
// built, add `{ status: 1, createdAt: 1 }` back alongside it.
export async function ensureImageModerationIndexes(): Promise<void> {
  // v1.22: the Mini App asks "is my newest profile photo still waiting?" on every pulse
  await (await col()).createIndexes([{ key: { senderId: 1, type: 1, createdAt: -1 }, name: "sender_type_created" }]);
}

/** True only while the user's NEWEST profile-photo record is still pending (an old, forgotten pending record can never
 *  keep showing «در انتظار تأیید» after a later photo was approved). */
export async function hasPendingProfilePhoto(userId: number): Promise<boolean> {
  const c = await col();
  const [latest] = await c.find({ senderId: userId, type: "profile_photo" }).sort({ createdAt: -1 }).limit(1).toArray();
  return latest?.status === "pending";
}

export async function createModerationRecord(input: {
  type: ModerationType;
  senderId: number;
  recipientId?: number;
  chatSessionId?: string;
  fileId: string;
  status: ModerationStatus;
  aiScore?: number;
  aiClassification?: string;
}): Promise<ImageModerationDoc> {
  const doc: ImageModerationDoc = { _id: randomUUID(), createdAt: new Date(), ...input };
  const c = await col();
  // a newer profile photo replaces every older request that is still waiting (nobody needs to decide on it any more)
  if (input.type === "profile_photo") await c.updateMany({ senderId: input.senderId, type: "profile_photo", status: "pending" }, { $set: { status: "superseded", reviewedAt: new Date() } });
  await c.insertOne(doc);
  return doc;
}

export type DecideResult = { status: "decided"; doc: ImageModerationDoc } | { status: "already_decided" } | { status: "not_found" };

/** Atomically transitions a pending record — filter requires status
 *  "pending" so duplicate/concurrent admin taps can only succeed once. */
export async function decideModerationRecord(id: string, decision: "approved" | "rejected", decidedBy: number): Promise<DecideResult> {
  const c = await col();
  const updated = await c.findOneAndUpdate(
    { _id: id, status: "pending" },
    { $set: { status: decision, reviewedAt: new Date(), reviewingAdmin: decidedBy } },
    { returnDocument: "after" }
  );
  if (updated) return { status: "decided", doc: updated };

  const existing = await c.findOne({ _id: id });
  if (!existing) return { status: "not_found" };
  return { status: "already_decided" };
}
