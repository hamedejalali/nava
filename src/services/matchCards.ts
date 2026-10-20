import { getDb } from "../db/connect.js";
import { getBlockedCounterparts } from "../db/models/blocks.js";
import { avatarUrl } from "./nava/present.js";
import { verifyMediaSig } from "./nava/media.js";
import { eligibleCandidateFilter } from "./miniapp.js";

/**
 * "Matching" tab cards.
 *  - GUEST (opened the mini-app without finishing registration in the bot): exactly GUEST_CARD_COUNT cards, always
 *    taken at random from the default (fictional) members, never from real people. No like / no other page.
 *  - MEMBER: random real, eligible people (visible, free, with an approved photo); needs his OWN approved photo.
 */
export const GUEST_CARD_COUNT = 5;

export interface MatchCard {
  id: string; // anonId
  name: string;
  age: number | null;
  city: string | null;
  province: string | null;
  bio: string;
  verified: boolean;
  av: string | null;
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
  return {
    id: u.anonId,
    name: u.nickname ?? "کاربر",
    age: typeof u.age === "number" ? u.age : u.age ? Number(u.age) || null : null,
    city: u.city ?? null,
    province: u.province ?? null,
    bio: String(u.bio ?? "").slice(0, 160),
    verified: !!u.verified,
    av: u.profilePhotoFileId ? avatarUrl(u.anonId, version) : null,
  };
}

export async function pickGuestCards(count = GUEST_CARD_COUNT): Promise<MatchCard[]> {
  const db = await getDb();
  const pool = await db
    .collection<any>("users")
    .find({ isSeed: true, seedHidden: { $ne: true }, banned: { $ne: true }, onboardingStep: "COMPLETED", profilePhotoFileId: { $type: "string", $ne: "" } })
    .limit(300)
    .toArray();
  return shuffle(pool).slice(0, count).map(toCard);
}

export async function pickMemberCards(me: any, excludeAnonIds: string[], count = 8): Promise<MatchCard[] | "need_photo"> {
  if (!me.profilePhotoFileId) return "need_photo";
  const db = await getDb();
  const blocked = await getBlockedCounterparts(me._id);
  const pool = await db
    .collection<any>("users")
    .find(eligibleCandidateFilter(me._id, blocked, excludeAnonIds) as any)
    .limit(300)
    .toArray();
  return shuffle(pool).slice(0, count).map(toCard);
}

export { verifyMediaSig };
