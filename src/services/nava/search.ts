import { C, SocialError, col, escapeRegex, findVisibleUser, hiddenOwnerIds, isAnonId, toBriefs, usersCol, visibleUserFilter, type Brief } from "./common.js";
import type { PostDoc } from "./posts.js";

/** Explore (everybody), precise search and "recent searches" of the Navagram Mini App. */

export const EXPLORE_PAGE = 24;
export const SEARCH_LIMIT = 30;
export const RECENT_MAX = 12;

export interface ExploreTile extends Brief {
  /** What the grid tile shows: the user's latest post, else the profile photo, else a placeholder. */
  mediaId: string | null;
  tilePv: string | null;
}

/**
 * EVERY registered user (except me / blocked / banned) — a user without a photo or without any post
 * still gets a tile (placeholder), so Explore can never look empty while the bot has users.
 */
export async function explore(viewerId: number, offsetRaw?: unknown): Promise<{ items: ExploreTile[]; hasMore: boolean; next: number }> {
  const offset = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(100_000, Math.floor(offsetRaw)) : 0;
  const hidden = await hiddenOwnerIds(viewerId);
  const users = await usersCol();
  const docs = await users
    .find(visibleUserFilter(viewerId, hidden))
    .sort({ createdAt: -1, _id: 1 })
    .skip(offset)
    .limit(EXPLORE_PAGE + 1)
    .toArray();
  const page = docs.slice(0, EXPLORE_PAGE);
  const briefs = await toBriefs(viewerId, page);

  // Latest post of EACH user on the page: one indexed "newest first, limit 1" lookup per user (at most
  // EXPLORE_PAGE of them). The old single query with a fixed row limit let a very active user's posts fill
  // the whole limit so other users on the page lost their tile picture.
  const latest = new Map<number, string>();
  if (page.length) {
    const posts = await col<PostDoc>(C.posts);
    const rows = await Promise.all(
      page.map((u: any) => posts.find({ ownerId: u._id } as any, { projection: { ownerId: 1, mediaId: 1 } }).sort({ createdAt: -1 }).limit(1).toArray()),
    );
    for (const [r] of rows) if (r) latest.set(r.ownerId, r.mediaId);
  }
  const items = briefs.map((b, i) => ({ ...b, mediaId: latest.get(page[i]._id) ?? null, tilePv: b.pv }));
  return { items, hasMore: docs.length > EXPLORE_PAGE, next: offset + page.length };
}

/* ------------------------------------------------------------------ search */

/** Lower-cases, folds Arabic/Persian letter variants and digits, drops "@", squeezes spaces. */
export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .replace(/[‌​‍ ]/g, " ")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ً-ٟـ]/g, "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase()
    .slice(0, 32);
}

/** A regex that also matches the Arabic look-alikes and a ZWNJ where the query has a space. */
function fuzzyRegex(q: string): RegExp {
  const src = escapeRegex(q)
    .replace(/ی/g, "[یيى]")
    .replace(/ک/g, "[کك]")
    .replace(/ /g, "[\\u200c ]");
  return new RegExp(src, "i");
}

function foldName(s: string): string {
  return normalizeQuery(s.replace(/[‌]/g, " "));
}

export function scoreMatch(q: string, u: { miniUsername?: string | null; nickname?: string | null; anonId?: string | null; verified?: boolean }): number {
  const un = (u.miniUsername ?? "").toLowerCase();
  const nm = foldName(u.nickname ?? "");
  const id = (u.anonId ?? "").toLowerCase();
  let s = 0;
  if (un) {
    if (un === q) s = Math.max(s, 100);
    else if (un.startsWith(q)) s = Math.max(s, 80);
    else if (un.includes(q)) s = Math.max(s, 50);
  }
  if (nm) {
    if (nm === q) s = Math.max(s, 90);
    else if (nm.startsWith(q)) s = Math.max(s, 70);
    else if (nm.split(" ").some((w) => w.startsWith(q))) s = Math.max(s, 60);
    else if (nm.includes(q)) s = Math.max(s, 40);
  }
  if (id) {
    if (id === q) s = Math.max(s, 95);
    else if (id.includes(q)) s = Math.max(s, 30);
  }
  return s > 0 && u.verified ? s + 3 : s;
}

export async function searchPeople(viewerId: number, rawQuery: unknown): Promise<Brief[]> {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];
  const hidden = await hiddenOwnerIds(viewerId);
  const users = await usersCol();
  const plain = new RegExp(escapeRegex(q), "i");
  const docs = await users
    .find({
      ...visibleUserFilter(viewerId, hidden),
      $or: [{ miniUsernameLower: plain }, { nickname: fuzzyRegex(q) }, { anonId: plain }],
    })
    .limit(200)
    .toArray();
  const ranked = docs
    .map((d: any) => ({ d, s: scoreMatch(q, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(a.d.miniUsername ?? a.d.nickname ?? "").localeCompare(String(b.d.miniUsername ?? b.d.nickname ?? "")))
    .slice(0, SEARCH_LIMIT)
    .map((x) => x.d);
  return toBriefs(viewerId, ranked);
}

/* ----------------------------------------------------------------- recents */

export async function recentList(viewerId: number): Promise<Brief[]> {
  const recent = await col(C.recent);
  const rows = await recent.find({ userId: viewerId }).sort({ at: -1 }).limit(RECENT_MAX).toArray();
  if (!rows.length) return [];
  const hidden = await hiddenOwnerIds(viewerId);
  const users = await usersCol();
  const docs = await users.find({ _id: { $in: rows.map((r: any) => r.targetId).filter((i: number) => !hidden.includes(i)) }, onboardingStep: "COMPLETED", banned: { $ne: true } }).toArray();
  const by = new Map(docs.map((d: any) => [d._id as number, d]));
  const ordered = rows.map((r: any) => by.get(r.targetId)).filter(Boolean);
  return toBriefs(viewerId, ordered);
}

export async function recentAdd(viewer: any, anonId: unknown): Promise<void> {
  const target = await findVisibleUser(viewer._id, anonId);
  if (!target) throw new SocialError("not_found");
  const recent = await col(C.recent);
  await recent.updateOne({ _id: `${viewer._id}:${target._id}` }, { $set: { userId: viewer._id, targetId: target._id, at: new Date() } }, { upsert: true });
  const all = await recent.find({ userId: viewer._id }, { projection: { _id: 1 } }).sort({ at: -1 }).skip(RECENT_MAX * 2).limit(50).toArray();
  if (all.length) await recent.deleteMany({ _id: { $in: all.map((a: any) => a._id) } });
}

export async function recentRemove(viewer: any, anonId: unknown): Promise<void> {
  if (!isAnonId(anonId)) throw new SocialError("not_found");
  const users = await usersCol();
  const target = await users.findOne({ anonId }, { projection: { _id: 1 } });
  if (target) await (await col(C.recent)).deleteOne({ _id: `${viewer._id}:${target._id}` });
}

export async function recentClear(viewer: any): Promise<void> {
  await (await col(C.recent)).deleteMany({ userId: viewer._id });
}
