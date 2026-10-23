import { getDb } from "../db/connect.js";
import { getBlockedCounterparts } from "../db/models/blocks.js";
import { avatarUrl } from "./nava/present.js";
import { verifyMediaSig } from "./nava/media.js";
import { eligibleCandidateFilter } from "./miniapp.js";
import { env } from "../config/env.js";
import { effectiveHide } from "./nava/profile.js";
import { coinOf, isOfficial } from "./nava/common.js";

/**
 * "Matching" tab cards.
 *  - GUEST (opened the mini-app without finishing registration in the bot): exactly GUEST_CARD_COUNT cards, always
 *    taken at random from the default (fictional) members, never from real people. No like / no other page.
 *  - MEMBER WITH A PHOTO: EVERY eligible person, in random order, endlessly (people with a photo first).
 *  - MEMBER WITHOUT A PHOTO: only MEMBER_NO_PHOTO_CARDS cards in total, then "put your profile photo first".
 */
export const GUEST_CARD_COUNT = 5;

export const MEMBER_NO_PHOTO_CARDS = 6;
export const MATCH_BATCH = 10;
export const MATCH_MAX_EXCLUDE = 600;

export interface MatchCard {
  id: string; // anonId
  name: string;
  age: number | null;
  city: string | null;
  province: string | null;
  bio: string;
  verified: boolean;
  gold?: true;
  coin?: string;
  av: string | null;
  /** I already liked this person's profile photo (first post) */
  liked?: boolean;
}

function shuffle<T>(a: T[]): T[] {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j]!, x[i]!];
  }
  return x;
}

function toCard(u: any): MatchCard {
  const version = u.profilePhotoAt ? String(new Date(u.profilePhotoAt).getTime()) : "1";
  const hide = effectiveHide(u);
  return {
    id: u.anonId,
    name: u.nickname ?? "کاربر",
    age: hide.age ? null : typeof u.age === "number" ? u.age : u.age ? Number(u.age) || null : null,
    city: hide.location ? null : (u.city ?? null),
    province: hide.location ? null : (u.province ?? null),
    bio: hide.bio ? "" : String(u.bio ?? "").slice(0, 160),
    verified: !!u.verified || isOfficial(u),
    ...(isOfficial(u) && coinOf(u) ? { gold: true as const, coin: coinOf(u)! } : {}),
    av: u.profilePhotoFileId ? avatarUrl(u.anonId, version) : null,
  };
}

export async function pickGuestCards(count = GUEST_CARD_COUNT): Promise<MatchCard[]> {
  const db = await getDb();
  const pool = await db
    .collection<any>("users")
    .find({ isSeed: true, seedHidden: { $ne: true }, official: { $ne: true }, banned: { $ne: true }, onboardingStep: "COMPLETED", profilePhotoFileId: { $type: "string", $ne: "" } })
    .limit(300)
    .toArray();
  return shuffle(pool).slice(0, count).map(toCard);
}

export function sanitizeMatchExclude(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length <= 32).slice(0, MATCH_MAX_EXCLUDE);
}

/** Everybody the viewer may be shown: registered, not banned, not blocked either way, not himself, not the official
 *  account, not a hidden default member. A busy person IS shown (the card just cannot be chatted with). */
export async function pickMemberCards(me: any, excludeAnonIds: string[], count = MATCH_BATCH): Promise<MatchCard[] | "need_photo"> {
  const hasPhoto = !!me.profilePhotoFileId;
  let allowance = count;
  if (!hasPhoto) {
    allowance = MEMBER_NO_PHOTO_CARDS - Math.max(0, Number(me.matchServed) || 0);
    if (allowance <= 0) return "need_photo";
  }
  const db = await getDb();
  const users = db.collection<any>("users");
  const blocked = await getBlockedCounterparts(me._id);
  // people I already liked / asked to chat / skipped are never shown again
  const seenRows = await db.collection<any>("match_seen").find({ userId: me._id }, { projection: { targetId: 1 } }).limit(20000).toArray();
  const nin = [me._id, ...blocked, ...seenRows.map((r: any) => r.targetId as number)];
  if (env.OWNER_ID !== undefined) nin.push(env.OWNER_ID);
  const base = { _id: { $nin: nin }, onboardingStep: "COMPLETED", banned: { $ne: true }, seedHidden: { $ne: true }, official: { $ne: true }, anonId: { $nin: excludeAnonIds } };
  const withPhoto = await users.find({ ...base, profilePhotoFileId: { $type: "string", $ne: "" } } as any).limit(400).toArray();
  // people without a profile photo are never shown
  const pool = shuffle(withPhoto);
  const picked = pool.slice(0, allowance);
  if (!hasPhoto && picked.length) await users.updateOne({ _id: me._id }, { $inc: { matchServed: picked.length } });
  const likedRows = picked.length ? await db.collection<any>("profile_likes").find({ _id: { $in: picked.map((u: any) => `${me._id}:${u._id}`) } }, { projection: { _id: 1 } }).toArray() : [];
  const liked = new Set(likedRows.map((r: any) => String(r._id)));
  return picked.map((u: any) => ({ ...toCard(u), ...(liked.has(`${me._id}:${u._id}`) ? { liked: true } : {}) }));
}

export { verifyMediaSig };

/** Remembers that `me` has seen (liked / messaged / skipped) this person: the card never comes back. */
export async function markMatchSeen(me: any, targetAnonId: unknown): Promise<boolean> {
  if (typeof targetAnonId !== "string" || !/^user_[A-Za-z0-9]{3,40}$/.test(targetAnonId)) return false;
  const db = await getDb();
  const t: any = await db.collection<any>("users").findOne({ anonId: targetAnonId }, { projection: { _id: 1 } });
  if (!t || t._id === me._id) return false;
  await db.collection<any>("match_seen").updateOne({ _id: `${me._id}:${t._id}` } as any, { $setOnInsert: { userId: me._id, targetId: t._id, at: new Date() } }, { upsert: true });
  return true;
}

export async function markMatchSeenById(meId: number, targetId: number): Promise<void> {
  const db = await getDb();
  await db.collection<any>("match_seen").updateOne({ _id: `${meId}:${targetId}` } as any, { $setOnInsert: { userId: meId, targetId, at: new Date() } }, { upsert: true }).catch(() => {});
}
