import { getDb } from "../connect.js";
import { runInTransaction } from "../tx.js";
import { generateAnonId, type Gender, type UserDoc } from "./user.js";
import { getBotSettings, patchBotSettings } from "./settings.js";
import { SEED_ID_BASE, SEED_ID_MAX, isSeedId } from "../../services/seeds/ids.js";
import type { SearchType } from "./matchQueue.js";

/**
 * Default ("seed") members. A seed is an ordinary `users` document (so every Mini App / profile / search query
 * keeps working unchanged) with `isSeed: true` and an id from the reserved range. See services/seeds/ids.ts.
 *
 * Money: a seed has no Relic. It never pays, is never paid, and never receives gifts' value (the Mini App
 * blocks gift/chat-request actions while acting as a seed; chats with a seed are free for the real user).
 */

export interface SeedInput {
  nickname: string;
  gender: Gender;
  age: number;
  province: string;
  city: string;
  bio?: string;
  profilePhotoFileId?: string;
  verified?: boolean;
}

async function users() {
  return (await getDb()).collection<any>("users");
}

/** Next free seed id: max(existing seed id, including soft-deleted) + 1, so an id is never reused. */
async function nextSeedId(): Promise<number> {
  const u = await users();
  const [top] = await u.find({ _id: { $gte: SEED_ID_BASE, $lte: SEED_ID_MAX } }, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
  const next = top ? (top._id as number) + 1 : SEED_ID_BASE + 1;
  if (!isSeedId(next)) throw new Error("seed id range exhausted");
  return next;
}

export async function createSeed(input: SeedInput): Promise<UserDoc> {
  const settings = await getBotSettings();
  const u = await users();
  const now = new Date();
  // looks like a normal member that joined some days ago (Explore sorts by join date; a block of members all
  // "created a second ago" would look odd)
  const createdAt = new Date(now.getTime() - Math.floor(Math.random() * 12 * 86_400_000));
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = await nextSeedId();
    const doc: any = {
      _id: id,
      telegramId: id,
      firstName: input.nickname,
      anonId: generateAnonId(),
      isSeed: true,
      seedHidden: !!settings.seedsHidden,
      seedChatEnabled: !!settings.seedChatEnabled,
      languageCode: "fa",
      gender: input.gender,
      age: input.age,
      province: input.province,
      city: input.city,
      nickname: input.nickname,
      bio: input.bio ?? "",
      onboardingStep: "COMPLETED",
      relicBalance: 0,
      relicInitialized: true, // never receives the new-user Relic gift
      channelsExempt: true,
      likesCount: 0,
      createdAt,
      lastActivityAt: now,
      ...(input.verified ? { verified: true } : {}),
      ...(input.profilePhotoFileId ? { profilePhotoFileId: input.profilePhotoFileId, profilePhotoAt: now } : {}),
    };
    try {
      await u.insertOne(doc);
      return doc as UserDoc;
    } catch (err: any) {
      if (err?.code === 11000) continue; // id or anonId collision: allocate again
      throw err;
    }
  }
  throw new Error("could not allocate a seed member");
}

export async function getSeed(id: number): Promise<UserDoc | null> {
  if (!isSeedId(id)) return null;
  const u = await users();
  return u.findOne({ _id: id, isSeed: true, seedDeleted: { $ne: true } });
}

export async function getSeedByAnonId(anonId: string): Promise<UserDoc | null> {
  const u = await users();
  return u.findOne({ anonId, isSeed: true, seedDeleted: { $ne: true } });
}

export async function listSeeds(skip = 0, limit = 10): Promise<{ items: UserDoc[]; total: number }> {
  const u = await users();
  const filter = { isSeed: true, seedDeleted: { $ne: true } };
  const [items, total] = await Promise.all([u.find(filter).sort({ _id: 1 }).skip(skip).limit(limit).toArray(), u.countDocuments(filter)]);
  return { items, total };
}

export async function countSeeds(): Promise<number> {
  return (await users()).countDocuments({ isSeed: true, seedDeleted: { $ne: true } });
}

/** Every active seed (for the Mini App account switcher). */
export async function allSeeds(limit = 200): Promise<UserDoc[]> {
  return (await users()).find({ isSeed: true, seedDeleted: { $ne: true } }).sort({ _id: 1 }).limit(limit).toArray();
}

export type SeedPatch = Partial<Pick<UserDoc, "nickname" | "gender" | "age" | "province" | "city" | "bio" | "verified">> & { profilePhotoFileId?: string };

export async function updateSeed(id: number, patch: SeedPatch): Promise<UserDoc | null> {
  if (!isSeedId(id)) return null;
  const set: Record<string, unknown> = {};
  for (const k of ["nickname", "gender", "age", "province", "city", "bio", "verified"] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.nickname !== undefined) set.firstName = patch.nickname;
  if (patch.profilePhotoFileId) {
    set.profilePhotoFileId = patch.profilePhotoFileId;
    set.profilePhotoAt = new Date();
  }
  if (!Object.keys(set).length) return getSeed(id);
  return (await users()).findOneAndUpdate({ _id: id, isSeed: true, seedDeleted: { $ne: true } }, { $set: set }, { returnDocument: "after" });
}

/** Master switch: hide every seed from real users' Mini App (or show them again). Instant: it is one write per
 *  seed document and every Mini App query reads the flag from the document itself. */
export async function setSeedsHidden(hidden: boolean): Promise<void> {
  await patchBotSettings({ seedsHidden: hidden });
  await (await users()).updateMany({ isSeed: true }, { $set: { seedHidden: hidden } });
}

/** Master switch: may a real user whose random search found nobody be connected to a seed? */
export async function setSeedChatEnabled(enabled: boolean): Promise<void> {
  await patchBotSettings({ seedChatEnabled: enabled });
  await (await users()).updateMany({ isSeed: true }, { $set: { seedChatEnabled: enabled } });
}

/**
 * Soft delete: the member disappears everywhere (it is flagged banned, which every query already honours),
 * its follow links are removed so no counter keeps counting it, and its comments are taken back with their
 * counters. The numeric id stays reserved. A chat in progress is simply ended by the next sweep.
 */
export async function deleteSeed(id: number): Promise<boolean> {
  if (!isSeedId(id)) return false;
  const db = await getDb();
  const u = db.collection<any>("users");
  const seed = await u.findOneAndUpdate(
    { _id: id, isSeed: true, seedDeleted: { $ne: true } },
    { $set: { seedDeleted: true, banned: true, banReason: "seed deleted", seedChatEnabled: false, seedHidden: true } },
    { returnDocument: "after" },
  );
  if (!seed) return false;
  await db.collection("mini_follows").deleteMany({ $or: [{ followerId: id }, { followeeId: id }] });
  await db.collection("mini_follow_requests").deleteMany({ $or: [{ fromId: id }, { toId: id }] });
  // take back its comments together with their counters
  const comments = db.collection<any>("mini_comments");
  const mine = await comments.find({ ownerId: id }).limit(2000).toArray();
  for (const c of mine) {
    const gone = await comments.deleteOne({ _id: c._id });
    if (gone.deletedCount !== 1) continue;
    if (typeof c.postId === "string" && c.postId.startsWith("pp:")) {
      const target = await u.findOne({ anonId: c.postId.slice(3) }, { projection: { _id: 1 } });
      if (target) await u.updateOne({ _id: target._id, profileCommentsCount: { $gt: 0 } }, { $inc: { profileCommentsCount: -1 } });
    } else {
      await db.collection<any>("mini_posts").updateOne({ _id: c.postId, commentsCount: { $gt: 0 } }, { $inc: { commentsCount: -1 } });
    }
  }
  return true;
}

/* ------------------------------------------------------- search fallback */

const RECENT_SEED_MS = 24 * 3_600_000;

export async function ensureSeedIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection("seed_chat_log").createIndexes([
    { key: { userId: 1, at: -1 }, name: "userId_at" },
    { key: { at: 1 }, name: "at_ttl", expireAfterSeconds: 7 * 86_400 },
  ]);
  await db.collection("seed_chat_jobs").createIndexes([
    { key: { state: 1, endAt: 1 }, name: "state_endAt" },
    { key: { createdAt: 1 }, name: "createdAt_ttl", expireAfterSeconds: 14 * 86_400 },
  ]);
}

export async function recentSeedIdsFor(userId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.collection<any>("seed_chat_log").find({ userId, at: { $gt: new Date(Date.now() - RECENT_SEED_MS) } }).limit(200).toArray();
  return rows.map((r: any) => r.seedId as number);
}

/** The Mongo filter a seed must satisfy to be offered to a real searcher. */
export function seedCandidateFilter(me: { gender?: Gender; age?: number; province?: string }, searchType: SearchType, excludeIds: number[]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    isSeed: true,
    seedDeleted: { $ne: true },
    seedChatEnabled: true,
    banned: { $ne: true },
    onboardingStep: "COMPLETED",
    activeChatSessionId: null,
    _id: { $nin: excludeIds },
  };
  if (searchType === "male") base.gender = "male";
  else if (searchType === "female") base.gender = "female";
  else if (searchType === "same_age") base.age = me.age;
  else if (searchType === "same_province") base.province = me.province;
  return base;
}

/** One random eligible seed for this search, or null. */
export async function pickSeedFor(me: { gender?: Gender; age?: number; province?: string }, searchType: SearchType, excludeIds: number[]): Promise<UserDoc | null> {
  const u = await users();
  const [doc] = await u.aggregate<any>([{ $match: seedCandidateFilter(me, searchType, excludeIds) }, { $sample: { size: 1 } }]).toArray();
  return doc ?? null;
}

export { runInTransaction };
