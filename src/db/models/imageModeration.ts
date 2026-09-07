import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export type ModerationType = "profile_photo" | "chat_image";
export type ModerationStatus = "pending" | "approved" | "rejected";

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

export async function ensureImageModerationIndexes(): Promise<void> {
  const c = await col();
  await c.createIndexes([
    { key: { senderId: 1 }, name: "senderId_1" },
    { key: { status: 1 }, name: "status_1" },
  ]);
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
  await (await col()).insertOne(doc);
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
