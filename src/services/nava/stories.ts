import { ARCHIVE_MS, C, SocialError, STORY_TTL_MS, col, cleanText, findVisibleUser, hiddenOwnerIds, isId, newId, toBriefs, usersCol, type Brief } from "./common.js";
import { decodeImage, deleteMedia, storeMedia } from "./media.js";

export const MAX_STORIES_PER_DAY = 40;
export const MAX_HIGHLIGHTS = 30;
export const MAX_HIGHLIGHT_STORIES = 100;
export const HIGHLIGHT_TITLE_MAX = 24;
export const STORY_CAPTION_MAX = 120;

export interface StoryDoc {
  _id: string;
  ownerId: number;
  mediaId: string;
  caption: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface StoryView {
  id: string;
  mediaId: string;
  caption: string;
  at: number;
  expiresAt: number;
  seen: boolean;
  views?: number; // owner only
}
export interface HighlightDoc {
  _id: string;
  ownerId: number;
  title: string;
  coverMediaId: string | null; // custom uploaded cover
  coverStoryId: string | null; // or a story of this highlight
  storyIds: string[];
  createdAt: Date;
  updatedAt: Date;
}
export interface HighlightBrief {
  id: string;
  title: string;
  coverMediaId: string | null;
  count: number;
}

/* -------------------------------------------------------------- stories */

export async function createStory(owner: any, imageRaw: unknown, captionRaw: unknown): Promise<StoryView> {
  const caption = captionRaw == null || captionRaw === "" ? "" : cleanText(captionRaw, STORY_CAPTION_MAX);
  const buf = decodeImage(imageRaw);
  const stories = await col<StoryDoc>(C.stories);
  const todayCount = await stories.countDocuments({ ownerId: owner._id, createdAt: { $gt: new Date(Date.now() - 86_400_000) } });
  if (todayCount >= MAX_STORIES_PER_DAY) throw new SocialError("too_many");
  const mediaId = await storeMedia(owner._id, "story", buf);
  const now = new Date();
  const doc: StoryDoc = { _id: newId(), ownerId: owner._id, mediaId, caption, createdAt: now, expiresAt: new Date(now.getTime() + STORY_TTL_MS) };
  await stories.insertOne(doc as any);
  return { id: doc._id, mediaId, caption, at: now.getTime(), expiresAt: doc.expiresAt.getTime(), seen: true, views: 0 };
}

function toView(d: StoryDoc, seen: boolean, views?: number): StoryView {
  const v: StoryView = { id: d._id, mediaId: d.mediaId, caption: d.caption ?? "", at: d.createdAt.getTime(), expiresAt: d.expiresAt.getTime(), seen };
  if (views !== undefined) v.views = views;
  return v;
}

async function viewCounts(ids: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (!ids.length) return m;
  const views = await col(C.storyViews);
  const rows = await views.find({ storyId: { $in: ids } }, { projection: { storyId: 1 } }).toArray();
  for (const r of rows) m.set(r.storyId, (m.get(r.storyId) ?? 0) + 1);
  return m;
}

/** Active (< 24h) stories of one user, oldest first (the order they are played). */
export async function activeStoriesOf(viewerId: number, anonId: unknown): Promise<{ owner: Brief; stories: StoryView[] } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner) return null;
  const stories = await col<StoryDoc>(C.stories);
  const docs = await stories.find({ ownerId: owner._id, expiresAt: { $gt: new Date() } } as any).sort({ createdAt: 1 }).limit(100).toArray();
  const views = await col(C.storyViews);
  const seenRows = docs.length ? await views.find({ _id: { $in: docs.map((d) => `${d._id}:${viewerId}`) } }, { projection: { _id: 1 } }).toArray() : [];
  const seen = new Set(seenRows.map((r: any) => String(r._id)));
  const mine = owner._id === viewerId;
  const counts = mine ? await viewCounts(docs.map((d) => d._id)) : null;
  const [brief] = await toBriefs(viewerId, [owner]);
  return { owner: brief!, stories: docs.map((d) => toView(d, mine || seen.has(`${d._id}:${viewerId}`), mine ? (counts!.get(d._id) ?? 0) : undefined)) };
}

/** Home stories tray: the viewer first, then everybody with an active story (unseen first). */
export async function storiesTray(viewerId: number): Promise<Brief[]> {
  const hidden = await hiddenOwnerIds(viewerId);
  const stories = await col<StoryDoc>(C.stories);
  const rows = await stories.find({ ownerId: { $nin: hidden }, expiresAt: { $gt: new Date() } } as any).sort({ createdAt: -1 }).limit(400).toArray();
  const latest = new Map<number, number>();
  for (const r of rows) if (!latest.has(r.ownerId)) latest.set(r.ownerId, r.createdAt.getTime());
  const ids = [...latest.keys()];
  if (!ids.length) return [];
  const users = await usersCol();
  const owners = await users.find({ _id: { $in: ids }, onboardingStep: "COMPLETED", banned: { $ne: true } }).toArray();
  const briefs = await toBriefs(viewerId, owners);
  const order = new Map(owners.map((o: any, i: number) => [briefs[i]!.id, { me: o._id === viewerId, t: latest.get(o._id) ?? 0 }]));
  return briefs.sort((a, b) => {
    const A = order.get(a.id)!, B = order.get(b.id)!;
    if (A.me !== B.me) return A.me ? -1 : 1;
    if ((a.story === 2) !== (b.story === 2)) return a.story === 2 ? -1 : 1;
    return B.t - A.t;
  });
}

export async function markStoryViewed(viewer: any, storyId: unknown): Promise<boolean> {
  if (!isId(storyId)) return false;
  const stories = await col<StoryDoc>(C.stories);
  const s = await stories.findOne({ _id: storyId } as any);
  if (!s) return false;
<<<<<<< HEAD
  const hidden = await hiddenOwnerIds(viewer._id);
=======
  const hidden = await hiddenOwnerIds(viewer._id, { direct: true });
>>>>>>> v1.11.0-wallet
  if (hidden.includes(s.ownerId)) return false;
  if (s.ownerId === viewer._id) return true;
  const views = await col(C.storyViews);
  try {
    await views.insertOne({ _id: `${s._id}:${viewer._id}`, storyId: s._id, ownerId: s.ownerId, viewerId: viewer._id, createdAt: new Date() });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  return true;
}

export async function storyViewers(owner: any, storyId: unknown): Promise<{ count: number; viewers: Brief[] }> {
  if (!isId(storyId)) throw new SocialError("not_found");
  const stories = await col<StoryDoc>(C.stories);
  const s = await stories.findOne({ _id: storyId, ownerId: owner._id } as any);
  if (!s) throw new SocialError("not_found");
  const views = await col(C.storyViews);
  const rows = await views.find({ storyId: s._id }).sort({ createdAt: -1 }).limit(100).toArray();
  const count = await views.countDocuments({ storyId: s._id });
  const users = await usersCol();
  const docs = await users.find({ _id: { $in: rows.map((r: any) => r.viewerId) } }).toArray();
  const briefs = await toBriefs(owner._id, docs);
  const by = new Map(docs.map((d: any, i: number) => [d._id as number, briefs[i]!]));
  return { count, viewers: rows.map((r: any) => by.get(r.viewerId)).filter(Boolean) as Brief[] };
}

<<<<<<< HEAD
export async function deleteStory(owner: any, storyId: unknown): Promise<void> {
  if (!isId(storyId)) throw new SocialError("not_found");
  const stories = await col<StoryDoc>(C.stories);
  const s = await stories.findOne({ _id: storyId, ownerId: owner._id } as any);
=======
export async function deleteStory(owner: any, storyId: unknown, opts: { asStaff?: boolean } = {}): Promise<{ ownerId: number } | void> {
  if (!isId(storyId)) throw new SocialError("not_found");
  const stories = await col<StoryDoc>(C.stories);
  const s = await stories.findOne(opts.asStaff ? ({ _id: storyId } as any) : ({ _id: storyId, ownerId: owner._id } as any));
>>>>>>> v1.11.0-wallet
  if (!s) throw new SocialError("not_found");
  await stories.deleteOne({ _id: s._id } as any);
  await (await col(C.storyViews)).deleteMany({ storyId: s._id });
  // remove it from any highlight; an emptied highlight disappears
  const hl = await col<HighlightDoc>(C.highlights);
<<<<<<< HEAD
  const holders = await hl.find({ ownerId: owner._id, storyIds: s._id } as any).toArray();
=======
  const holders = await hl.find({ ownerId: s.ownerId, storyIds: s._id } as any).toArray();
>>>>>>> v1.11.0-wallet
  const mediaToDelete: string[] = [s.mediaId];
  for (const h of holders) {
    const left = h.storyIds.filter((x) => x !== s._id);
    if (!left.length) {
      await hl.deleteOne({ _id: h._id } as any);
      if (h.coverMediaId) mediaToDelete.push(h.coverMediaId);
    } else {
      await hl.updateOne({ _id: h._id } as any, { $set: { storyIds: left, coverStoryId: h.coverStoryId === s._id ? left[0]! : h.coverStoryId, updatedAt: new Date() } });
    }
  }
  await deleteMedia(mediaToDelete);
<<<<<<< HEAD
=======
  return { ownerId: s.ownerId };
>>>>>>> v1.11.0-wallet
}

/** Owner's archive: every story of the last 30 days (including expired ones). */
export async function storyArchive(owner: any): Promise<StoryView[]> {
  const stories = await col<StoryDoc>(C.stories);
  const docs = await stories.find({ ownerId: owner._id, createdAt: { $gt: new Date(Date.now() - ARCHIVE_MS) } } as any).sort({ createdAt: -1 }).limit(120).toArray();
  return docs.map((d) => toView(d, true));
}

<<<<<<< HEAD
/** Daily housekeeping (called from the existing daily cron): drops archived stories that are
 *  older than 30 days and are not part of a highlight. Never throws. */
export async function cleanupStories(now = new Date(), batch = 200): Promise<number> {
  try {
    const stories = await col<StoryDoc>(C.stories);
    const old = await stories.find({ createdAt: { $lt: new Date(now.getTime() - ARCHIVE_MS) } } as any).limit(batch).toArray();
    if (!old.length) return 0;
    const hl = await col<HighlightDoc>(C.highlights);
    const held = new Set<string>();
    for (const s of old) if (await hl.findOne({ storyIds: s._id } as any)) held.add(s._id);
    const drop = old.filter((s) => !held.has(s._id));
    if (!drop.length) return 0;
    const ids = drop.map((s) => s._id);
    await stories.deleteMany({ _id: { $in: ids } } as any);
    await (await col(C.storyViews)).deleteMany({ storyId: { $in: ids } });
    await deleteMedia(drop.map((s) => s.mediaId));
    return drop.length;
=======
/** Which of these story ids are kept by a highlight (one query per page, not one per story). */
async function heldByHighlights(ids: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  if (!ids.length) return held;
  const hl = await col<HighlightDoc>(C.highlights);
  const docs = await hl.find({ storyIds: { $in: ids } } as any).project({ storyIds: 1 }).toArray();
  const wanted = new Set(ids);
  for (const d of docs as any[]) for (const sid of d.storyIds ?? []) if (wanted.has(sid)) held.add(sid);
  return held;
}

/** Daily housekeeping (called from the existing daily cron): drops archived stories that are
 *  older than 30 days and are not part of a highlight. Never throws.
 *
 *  Walks the expired stories oldest-first in pages (keyset on createdAt/_id) and keeps going past pages
 *  that are entirely highlighted, so a batch of retained stories can never starve the older-than-30-days
 *  ones behind it; work per run stays bounded (`batch` deletions, at most `maxPages` pages). */
export async function cleanupStories(now = new Date(), batch = 200, maxPages = 25): Promise<number> {
  try {
    const stories = await col<StoryDoc>(C.stories);
    const cutoff = new Date(now.getTime() - ARCHIVE_MS);
    const drop: StoryDoc[] = [];
    let after: { createdAt: Date; _id: string } | null = null;

    for (let page = 0; page < maxPages && drop.length < batch; page++) {
      const filter: any = after
        ? { $or: [{ createdAt: { $gt: after.createdAt, $lt: cutoff } }, { createdAt: after.createdAt, _id: { $gt: after._id } }] }
        : { createdAt: { $lt: cutoff } };
      const rows = await stories.find(filter).sort({ createdAt: 1, _id: 1 }).limit(batch).toArray();
      if (!rows.length) break;
      const held = await heldByHighlights(rows.map((s) => s._id));
      for (const s of rows) if (!held.has(s._id) && drop.length < batch) drop.push(s);
      const last = rows[rows.length - 1]!;
      after = { createdAt: last.createdAt, _id: last._id };
      if (rows.length < batch) break;
    }
    if (!drop.length) return 0;

    // A story may have been added to a highlight while we were paging: re-check just before deleting.
    const lateHeld = await heldByHighlights(drop.map((s) => s._id));
    const finalDrop = drop.filter((s) => !lateHeld.has(s._id));
    if (!finalDrop.length) return 0;
    const ids = finalDrop.map((s) => s._id);
    await stories.deleteMany({ _id: { $in: ids } } as any);
    await (await col(C.storyViews)).deleteMany({ storyId: { $in: ids } });
    await deleteMedia(finalDrop.map((s) => s.mediaId));
    return finalDrop.length;
>>>>>>> v1.11.0-wallet
  } catch (err) {
    console.error("[navagram] story cleanup failed:", err instanceof Error ? err.message : "unknown");
    return 0;
  }
}

/* ------------------------------------------------------------ highlights */

async function coverOf(h: HighlightDoc): Promise<string | null> {
  if (h.coverMediaId) return h.coverMediaId;
  const sid = h.coverStoryId ?? h.storyIds[0];
  if (!sid) return null;
  const s = await (await col<StoryDoc>(C.stories)).findOne({ _id: sid } as any);
  return s?.mediaId ?? null;
}

export async function highlightBriefs(ownerId: number): Promise<HighlightBrief[]> {
  const hl = await col<HighlightDoc>(C.highlights);
  const docs = await hl.find({ ownerId } as any).sort({ createdAt: 1 }).limit(MAX_HIGHLIGHTS).toArray();
  const out: HighlightBrief[] = [];
  for (const h of docs) out.push({ id: h._id, title: h.title, coverMediaId: await coverOf(h), count: h.storyIds.length });
  return out;
}

async function ownStoriesByIds(ownerId: number, ids: string[]): Promise<StoryDoc[]> {
  const stories = await col<StoryDoc>(C.stories);
  const docs = await stories.find({ _id: { $in: ids }, ownerId } as any).toArray();
  const by = new Map(docs.map((d) => [d._id, d]));
  return ids.map((i) => by.get(i)).filter(Boolean) as StoryDoc[];
}

function cleanTitle(raw: unknown): string {
  return cleanText(raw, HIGHLIGHT_TITLE_MAX, { min: 1 });
}
function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new SocialError("bad_input");
  const ids = [...new Set(raw.filter(isId))];
  if (!ids.length || ids.length > MAX_HIGHLIGHT_STORIES) throw new SocialError("bad_input");
  return ids;
}

export async function createHighlight(owner: any, input: { title: unknown; storyIds: unknown; coverStoryId?: unknown; coverImage?: unknown }): Promise<HighlightBrief> {
  const title = cleanTitle(input.title);
  const ids = cleanIds(input.storyIds);
  const hl = await col<HighlightDoc>(C.highlights);
  if ((await hl.countDocuments({ ownerId: owner._id })) >= MAX_HIGHLIGHTS) throw new SocialError("too_many");
  const owned = await ownStoriesByIds(owner._id, ids);
  if (owned.length !== ids.length) throw new SocialError("not_found");
  const coverStoryId = isId(input.coverStoryId) && ids.includes(input.coverStoryId) ? input.coverStoryId : ids[0]!;
  const coverMediaId = input.coverImage ? await storeMedia(owner._id, "cover", decodeImage(input.coverImage)) : null;
  const now = new Date();
  const doc: HighlightDoc = { _id: newId(), ownerId: owner._id, title, coverMediaId, coverStoryId, storyIds: ids, createdAt: now, updatedAt: now };
  await hl.insertOne(doc as any);
  return { id: doc._id, title, coverMediaId: await coverOf(doc), count: ids.length };
}

export async function editHighlight(owner: any, hid: unknown, input: { title?: unknown; storyIds?: unknown; coverStoryId?: unknown; coverImage?: unknown }): Promise<HighlightBrief> {
  if (!isId(hid)) throw new SocialError("not_found");
  const hl = await col<HighlightDoc>(C.highlights);
  const h = await hl.findOne({ _id: hid, ownerId: owner._id } as any);
  if (!h) throw new SocialError("not_found");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const mediaToDelete: string[] = [];
  let ids = h.storyIds;
  if (input.title !== undefined) set.title = cleanTitle(input.title);
  if (input.storyIds !== undefined) {
    ids = cleanIds(input.storyIds);
    const owned = await ownStoriesByIds(owner._id, ids);
    if (owned.length !== ids.length) throw new SocialError("not_found");
    set.storyIds = ids;
  }
  if (input.coverImage) {
    if (h.coverMediaId) mediaToDelete.push(h.coverMediaId);
    set.coverMediaId = await storeMedia(owner._id, "cover", decodeImage(input.coverImage));
    set.coverStoryId = null;
  } else if (isId(input.coverStoryId) && ids.includes(input.coverStoryId)) {
    if (h.coverMediaId) mediaToDelete.push(h.coverMediaId);
    set.coverStoryId = input.coverStoryId;
    set.coverMediaId = null; // a story cover replaces a previously uploaded one
  } else if (input.storyIds !== undefined && h.coverStoryId && !ids.includes(h.coverStoryId) && !h.coverMediaId) {
    set.coverStoryId = ids[0]!;
  }
  await hl.updateOne({ _id: h._id } as any, { $set: set });
  await deleteMedia(mediaToDelete);
  const fresh = (await hl.findOne({ _id: h._id } as any))!;
  return { id: fresh._id, title: fresh.title, coverMediaId: await coverOf(fresh), count: fresh.storyIds.length };
}

export async function deleteHighlight(owner: any, hid: unknown): Promise<void> {
  if (!isId(hid)) throw new SocialError("not_found");
  const hl = await col<HighlightDoc>(C.highlights);
  const h = await hl.findOne({ _id: hid, ownerId: owner._id } as any);
  if (!h) throw new SocialError("not_found");
  await hl.deleteOne({ _id: h._id } as any);
  await deleteMedia([h.coverMediaId]);
}

/** A highlight with its stories (what the viewer plays). */
export async function getHighlight(viewerId: number, hid: unknown): Promise<{ id: string; title: string; owner: Brief; stories: StoryView[]; coverStoryId: string | null; coverMediaId: string | null } | null> {
  if (!isId(hid)) return null;
  const hl = await col<HighlightDoc>(C.highlights);
  const h = await hl.findOne({ _id: hid } as any);
  if (!h) return null;
  const owner = await usersCol().then((u) => u.findOne({ _id: h.ownerId, onboardingStep: "COMPLETED", banned: { $ne: true } }));
  if (!owner) return null;
  const hidden = await hiddenOwnerIds(viewerId);
  if (hidden.includes(owner._id)) return null;
  const docs = await ownStoriesByIds(owner._id, h.storyIds);
  const [brief] = await toBriefs(viewerId, [owner]);
  return { id: h._id, title: h.title, owner: brief!, stories: docs.map((d) => toView(d, true)), coverStoryId: h.coverStoryId, coverMediaId: h.coverMediaId };
}
