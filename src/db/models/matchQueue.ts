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
  await col.createIndexes([
    { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
    // The candidate query (buildCandidateQuery below) is an OR across
    // several shapes, but `searchType` + `expiresAt` appears in most of
    // them (every branch of `theyAccept`). This collection is naturally
    // tiny and self-cleaning (TTL, ~40s max lifetime per entry), so a full
    // scan is not a real bottleneck at the scale this bot runs at — this
    // index is a cheap, low-risk improvement, not a fix for an observed
    // problem. Deliberately NOT adding one index per OR-branch: that would
    // slow down every search's write for a collection this small.
    { key: { searchType: 1, expiresAt: 1 }, name: "searchType_expiresAt" },
  ]);
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

/** Returns false when the entry no longer exists (the user was matched/cancelled in the meantime). */
export async function setQueueStatusMessageId(telegramId: number, messageId: number): Promise<boolean> {
  const col = await queueCollection();
  const r = await col.updateOne({ _id: telegramId }, { $set: { statusMessageId: messageId } });
  return r.matchedCount === 1;
}

/** Existence check that deliberately IGNORES `expiresAt`: the countdown owns the deadline itself, and an
 *  entry whose TTL moment just passed must still be handled (timeout message), never silently dropped. */
export async function queueEntryExists(telegramId: number): Promise<boolean> {
  const col = await queueCollection();
  return (await col.countDocuments({ _id: telegramId })) > 0;
}

/** Atomically removes the user's queue entry and tells the caller whether IT removed it. Whoever gets
 *  the document back "owns" the outcome (cancel / timeout), so cancel-vs-match and timeout-vs-match
 *  races can never produce two different answers. */
export async function claimQueueEntry(telegramId: number): Promise<MatchQueueDoc | null> {
  const col = await queueCollection();
  return col.findOneAndDelete({ _id: telegramId });
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
  excludeIds?: number[];
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

  const excludeIds = [me.telegramId, ...(me.excludeIds ?? [])];

  return {
    _id: { $nin: excludeIds },
    expiresAt: { $gt: new Date() },
    $and: [{ $or: iAccept }, { $or: theyAccept }],
  };
}
