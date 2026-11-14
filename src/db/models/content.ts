import type { Collection } from "mongodb";
import { getDb } from "../connect.js";
import { emojiSyntaxToTags } from "../../services/emojiSyntax.js";

/**
 * Admin-editable content (currently: the two guide texts from Feature 04's
 * admin panel). Stored in its own collection so it can be changed from the
 * admin panel and take effect immediately, without a new deployment.
 */
export type ContentKey = "guideText" | "guide1" | "pinnedPromo" | "rules" | "supportId" | "inviteMessage" | "maintenanceText";

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
export async function getContent(key: ContentKey, fallback: string, lang: "fa" | "en" | "ar" = "fa"): Promise<string> {
  const col = await contentCollection();
  // v1.31.0: en / ar texts are stored under "<key>:<lang>"; when the owner never wrote one, the Persian text is used
  const doc = (lang !== "fa" ? await col.findOne({ _id: `${key}:${lang}` as ContentKey }) : null) ?? (await col.findOne({ _id: key }));
  const text = doc?.text ?? fallback;
  // v1.27: the bot is now «مویا» and the mini-app «مویاگرام»: a text saved from the panel before the rename shows the new names too.
  return key === "supportId" ? text : emojiSyntaxToTags(renameBrand(text));
}

/** «نوا گرام» → «مویاگرام», «نوا» → «مویا» (whole words only). */
export function renameBrand(text: string): string {
  return text.replace(/نوا ?گرام/g, "مویاگرام").replace(/(?<![\u0600-\u06FF])نوا(?![\u0600-\u06FF])/g, "مویا");
}

export async function setContent(key: ContentKey, text: string, updatedBy: number, lang: "fa" | "en" | "ar" = "fa"): Promise<void> {
  const col = await contentCollection();
  await col.updateOne({ _id: (lang === "fa" ? key : `${key}:${lang}`) as ContentKey }, { $set: { text, updatedAt: new Date(), updatedBy } }, { upsert: true });
}

/** The text exactly as the owner typed it (emoji syntax NOT converted) — for the editor. undefined when never overridden. */
export async function getContentRaw(key: ContentKey, lang: "fa" | "en" | "ar" = "fa"): Promise<string | undefined> {
  const col = await contentCollection();
  return (await col.findOne({ _id: (lang === "fa" ? key : `${key}:${lang}`) as ContentKey }))?.text;
}

export async function clearContent(key: ContentKey, lang: "fa" | "en" | "ar" = "fa"): Promise<void> {
  const col = await contentCollection();
  await col.deleteOne({ _id: (lang === "fa" ? key : `${key}:${lang}`) as ContentKey });
}
