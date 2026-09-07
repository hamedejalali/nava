import type { Collection } from "mongodb";
import { getDb } from "../connect.js";

/**
 * Admin-editable content (currently: the two guide texts from Feature 04's
 * admin panel). Stored in its own collection so it can be changed from the
 * admin panel and take effect immediately, without a new deployment.
 */
export type ContentKey = "guideText" | "guide1" | "pinnedPromo" | "rules" | "supportId";

export interface ContentDoc {
  _id: ContentKey;
  text: string;
  updatedAt: Date;
  updatedBy: number;
}

async function contentCollection(): Promise<Collection<ContentDoc>> {
  const db = await getDb();
  return db.collection<ContentDoc>("content");
}

/** Returns the admin-configured text for `key`, or `fallback` if the admin
 *  has never overridden it yet. */
export async function getContent(key: ContentKey, fallback: string): Promise<string> {
  const col = await contentCollection();
  const doc = await col.findOne({ _id: key });
  return doc?.text ?? fallback;
}

export async function setContent(key: ContentKey, text: string, updatedBy: number): Promise<void> {
  const col = await contentCollection();
  await col.updateOne({ _id: key }, { $set: { text, updatedAt: new Date(), updatedBy } }, { upsert: true });
}
