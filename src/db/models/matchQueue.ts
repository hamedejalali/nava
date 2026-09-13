import type { Collection } from "mongodb";
import { getDb } from "../connect.js";
import type { Gender } from "./user.js";

export type SearchType = "lucky" | "male" | "female" | "same_age" | "same_province";
// "nearby" is intentionally excluded: no feature has ever collected GPS
// location, so a nearby search can never have a valid candidate pool. It is
// handled entirely client-side (a graceful message, no queue entry) — see
// src/features/matching/search.ts.

export const SEARCH_TIMEOUT_MS = 40 * 1000; // "حداکثر تا ۴۰ ثانیه"

export interface MatchQueueDoc {
  _id: number; // telegramId — one active search per user, natural dedup
  searchType: SearchType;
  genderSnapshot: Gender;
  ageSnapshot: number;
  provinceSnapshot?: string;
  /** The "🔎 در حال جستجو..." message, so it can be deleted once matched or expired. */
  statusMessageId?: number;
  createdAt: Date;
  /** Set once the "search timed out" notification has been sent, so the
   *  cron job (api/cron/expire-searches.ts) never sends it twice even if
   *  it runs again before MongoDB's TTL cleanup removes the document. */
  timeoutNotified?: boolean;
  /** TTL field — MongoDB automatically removes the document once this
   *  passes, so an abandoned search is cleaned up even if no further
   *  request ever runs for this user (see ensureMatchQueueIndexes). */
  expiresAt: Date;
}

async function queueCollection(): Promise<Collection<MatchQueueDoc>> {
  const db = await getDb();
  return db.collection<MatchQueueDoc>("match_queue");
}

export async function ensureMatchQueueIndexes(): Promise<void> {
  const col = await queueCollection();
  await col.createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]);
}

export async function upsertQueueEntry(doc: Omit<MatchQueueDoc, "createdAt">): Promise<void> {
  const col = await queueCollection();
  await col.updateOne({ _id: doc._id }, { $set: { ...doc, createdAt: new Date() } }, { upsert: true });
}

export async function getQueueEntry(telegramId: number): Promise<MatchQueueDoc | null> {
  const col = await queueCollection();
  return col.findOne({ _id: telegramId, expiresAt: { $gt: new Date() } });
}

export async function removeQueueEntry(telegramId: number): Promise<void> {
  const col = await queueCollection();
  await col.deleteOne({ _id: telegramId });
}

export async function setQueueStatusMessageId(telegramId: number, messageId: number): Promise<void> {
  const col = await queueCollection();
  await col.updateOne({ _id: telegramId }, { $set: { statusMessageId: messageId } });
}

/** For the timeout-notification cron job: entries whose deadline already
 *  passed but that haven't been notified/cleaned up yet. */
export async function findExpiredUnnotified(): Promise<MatchQueueDoc[]> {
  const col = await queueCollection();
  return col.find({ expiresAt: { $lte: new Date() }, timeoutNotified: { $ne: true } }).toArray();
}

/** Builds the reciprocal-compatibility query: candidates that (a) my
 *  search type would accept, AND (b) whose own search type would accept
 *  me — expressed purely with the snapshot fields stored on each queue
 *  document, so no join/lookup is needed for the atomic match attempt. */
export function buildCandidateQuery(me: {
  telegramId: number;
  searchType: SearchType;
  gender: Gender;
  age: number;
  province?: string;
}) {
  const iAccept: Record<string, unknown>[] =
    me.searchType === "lucky"
      ? [{}]
      : me.searchType === "male"
        ? [{ genderSnapshot: "male" }]
        : me.searchType === "female"
          ? [{ genderSnapshot: "female" }]
          : me.searchType === "same_age"
            ? [{ ageSnapshot: me.age }]
            : [{ provinceSnapshot: me.province }]; // same_province

  const theyAccept: Record<string, unknown>[] = [
    { searchType: "lucky" },
    ...(me.gender === "male" ? [{ searchType: "male" }] : []),
    ...(me.gender === "female" ? [{ searchType: "female" }] : []),
    { searchType: "same_age", ageSnapshot: me.age },
    ...(me.province ? [{ searchType: "same_province", provinceSnapshot: me.province }] : []),
  ];

  return {
    _id: { $ne: me.telegramId },
    expiresAt: { $gt: new Date() },
    $and: [{ $or: iAccept }, { $or: theyAccept }],
  };
}
