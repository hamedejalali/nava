import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../../db/connect.js";
import { getBlockedCounterparts } from "../../db/models/blocks.js";
import type { UserDoc } from "../../db/models/user.js";
import { env } from "../../config/env.js";

/** Shared helpers of the Navagram (نوا گرام) Mini App backend. */

export class SocialError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const C = {
  media: "mini_media",
  posts: "mini_posts",
  postLikes: "mini_post_likes",
  comments: "mini_comments",
  follows: "mini_follows",
  followRequests: "mini_follow_requests",
  stories: "mini_stories",
  storyViews: "mini_story_views",
  highlights: "mini_highlights",
  gifts: "mini_gifts",
  giftDefs: "mini_gift_defs",
  recent: "mini_recent_search",
  settings: "mini_settings",
} as const;

export const DAY_MS = 86_400_000;
export const STORY_TTL_MS = DAY_MS; // stories are visible for 24 hours
export const ARCHIVE_MS = 30 * DAY_MS; // …and kept in the owner's archive for 30 days (highlights keep them forever)

export function newId(): string {
  return randomBytes(9).toString("base64url");
}
const ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
export function isId(x: unknown): x is string {
  return typeof x === "string" && ID_RE.test(x);
}
/** Public Nava ID of a user (anonId), e.g. user_5RR1rD. */
export function isAnonId(x: unknown): x is string {
  return typeof x === "string" && x.length >= 3 && x.length <= 32 && /^[A-Za-z0-9_]+$/.test(x);
}
/** Post id: either a real post id, or "pp:<anonId>" = the user's profile-photo post. */
export function parsePid(x: unknown): { kind: "post"; id: string } | { kind: "profile"; anonId: string } | null {
  if (typeof x !== "string") return null;
  if (x.startsWith("pp:")) {
    const a = x.slice(3);
    return isAnonId(a) ? { kind: "profile", anonId: a } : null;
  }
  return isId(x) ? { kind: "post", id: x } : null;
}

/** Changes whenever the profile photo changes, so clients never show a stale cached picture. */
export function photoVer(fileId?: string | null): string | null {
  if (!fileId) return null;
  return createHash("md5").update(fileId).digest("hex").slice(0, 8);
}

export function cleanText(raw: unknown, max: number, opts: { multiline?: boolean; min?: number } = {}): string {
  if (typeof raw !== "string") throw new SocialError("bad_text");
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮]/g, "").replace(/\r\n?/g, "\n").trim();
  if (!opts.multiline) s = s.replace(/\s*\n\s*/g, " ");
  else s = s.replace(/\n{3,}/g, "\n\n");
  if ([...s].length < (opts.min ?? 0)) throw new SocialError("bad_text");
  if ([...s].length > max) throw new SocialError("text_too_long");
  return s;
}

export async function usersCol() {
  return (await getDb()).collection<any>("users");
}
export async function col<T extends import("mongodb").Document = any>(name: string) {
  return (await getDb()).collection<T>(name);
}

/** Ids whose content the viewer must not see: blocked either way + banned users. */
export function isStaffId(id: number): boolean {
  return (env.OWNER_ID !== undefined && id === env.OWNER_ID) || env.ADMIN_IDS.includes(id);
}

/** `direct`: the viewer opened ONE specific profile / post / story. The owner and the configured admins can open
 *  anyone's (blocked or banned included) so they can moderate; feeds, explore and search never use this. */
export async function hiddenOwnerIds(viewerId: number, opts: { direct?: boolean } = {}): Promise<number[]> {
  if (opts.direct && isStaffId(viewerId)) return [];
  const blocked = await getBlockedCounterparts(viewerId);
  const users = await usersCol();
  // banned people AND default (seed) members that the owner switched to "hidden" — one query, one flag read
  // from the member document itself, so switching them off/on takes effect on the very next call
  const banned = await users.find({ $or: [{ banned: true }, { seedHidden: true }] }, { projection: { _id: 1 } }).toArray();
  return [...new Set([...blocked, ...banned.map((b: any) => b._id as number)])];
}

/**
 * PRIVATE PAGES. Owners with `isPrivate` show their posts, stories, highlights and follow lists only to people
 * they approved (an existing follow = approved) and to themselves; the owner/env-admins keep moderation access.
 * Returns the private owners whose content THIS viewer may not see. Their profile header (name, photo, bio,
 * counts) stays visible, exactly like Instagram.
 */
export async function lockedOwnerIds(viewerId: number): Promise<number[]> {
  if (isStaffId(viewerId)) return [];
  const users = await usersCol();
  const priv = await users.find({ isPrivate: true, _id: { $ne: viewerId } }, { projection: { _id: 1 } }).toArray();
  if (!priv.length) return [];
  const ids = priv.map((p: any) => p._id as number);
  const f = await col(C.follows);
  const followed = await f.find({ followerId: viewerId, followeeId: { $in: ids } }, { projection: { followeeId: 1 } }).toArray();
  const ok = new Set(followed.map((x: any) => x.followeeId as number));
  return ids.filter((i) => !ok.has(i));
}

/** Same rule for users already loaded (only the few private ones among them cost a lookup). */
export async function lockedAmong(viewerId: number, docs: Array<{ _id: number; isPrivate?: boolean }>): Promise<Set<number>> {
  if (isStaffId(viewerId)) return new Set();
  const priv = docs.filter((d) => d.isPrivate && d._id !== viewerId).map((d) => d._id);
  if (!priv.length) return new Set();
  const f = await col(C.follows);
  const followed = await f.find({ followerId: viewerId, followeeId: { $in: priv } }, { projection: { followeeId: 1 } }).toArray();
  const ok = new Set(followed.map((x: any) => x.followeeId as number));
  return new Set(priv.filter((i) => !ok.has(i)));
}

/** Filter for "a registered user the viewer may see anywhere in the app". */
export function visibleUserFilter(viewerId: number, hidden: number[], opts: { includeSelf?: boolean } = {}): Record<string, unknown> {
  const nin = opts.includeSelf ? hidden : [viewerId, ...hidden];
  return { _id: { $nin: nin }, onboardingStep: "COMPLETED", banned: { $ne: true } };
}

export interface Brief {
  id: string; // anonId
  username: string | null;
  name: string;
  verified: boolean;
  pv: string | null; // photo version (null = no photo)
  story: 0 | 1 | 2; // 0 none, 1 all seen, 2 has unseen
}

export async function activeStoryOwners(viewerId: number, ownerIds: number[], now = new Date()): Promise<Map<number, 1 | 2>> {
  const out = new Map<number, 1 | 2>();
  if (!ownerIds.length) return out;
  const stories = await col(C.stories);
  const rows = await stories.find({ ownerId: { $in: ownerIds }, expiresAt: { $gt: now } }, { projection: { _id: 1, ownerId: 1 } }).toArray();
  if (!rows.length) return out;
  const views = await col(C.storyViews);
  const seen = await views.find({ _id: { $in: rows.map((r: any) => `${r._id}:${viewerId}`) } }, { projection: { _id: 1 } }).toArray();
  const seenSet = new Set(seen.map((v: any) => String(v._id)));
  for (const r of rows) {
    const isSeen = r.ownerId === viewerId || seenSet.has(`${r._id}:${viewerId}`);
    const cur = out.get(r.ownerId);
    if (!isSeen) out.set(r.ownerId, 2);
    else if (!cur) out.set(r.ownerId, 1);
  }
  return out;
}

export async function toBriefs(viewerId: number, docs: any[]): Promise<Brief[]> {
  const st = await activeStoryOwners(viewerId, docs.map((d) => d._id));
  // a private page's story ring is not shown to people who may not open it
  const locked = await lockedAmong(viewerId, docs);
  for (const id of locked) st.delete(id);
  return docs.map((u) => ({
    id: u.anonId,
    username: u.miniUsername ?? null,
    name: u.nickname ?? "-",
    verified: !!u.verified,
    pv: photoVer(u.profilePhotoFileId),
    story: (st.get(u._id) ?? 0) as 0 | 1 | 2,
  }));
}

export async function findVisibleUser(viewerId: number, anonId: unknown, opts: { includeSelf?: boolean } = {}): Promise<any | null> {
  if (!isAnonId(anonId)) return null;
  if (isStaffId(viewerId)) return (await usersCol()).findOne({ onboardingStep: "COMPLETED", anonId });
  const hidden = await hiddenOwnerIds(viewerId);
  const users = await usersCol();
  return users.findOne({ ...visibleUserFilter(viewerId, hidden, opts), anonId });
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
