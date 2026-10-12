import { C, SocialError, col, findVisibleUser, hiddenOwnerIds, toBriefs, usersCol, type Brief } from "./common.js";

export const FOLLOW_PAGE = 30;

export async function followCounts(userId: number): Promise<{ followers: number; following: number }> {
  const f = await col(C.follows);
  return { followers: await f.countDocuments({ followeeId: userId }), following: await f.countDocuments({ followerId: userId }) };
}

/** Idempotent: following twice counts once, unfollowing twice is a no-op. */
export async function setFollow(viewer: any, anonId: unknown, follow: boolean): Promise<{ following: boolean; followers: number } | null> {
  if (anonId === viewer.anonId) throw new SocialError("self");
  const target = await findVisibleUser(viewer._id, anonId);
  if (!target) return null;
  const f = await col(C.follows);
  const key = `${viewer._id}:${target._id}`;
  if (follow) {
    try {
      await f.insertOne({ _id: key, followerId: viewer._id, followeeId: target._id, createdAt: new Date() });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  } else {
    await f.deleteOne({ _id: key });
  }
  return { following: !!(await f.findOne({ _id: key })), followers: await f.countDocuments({ followeeId: target._id }) };
}

export interface FollowRow extends Brief {
  iFollow: boolean;
  isMe: boolean;
}

export async function listFollows(viewerId: number, anonId: unknown, type: unknown, before?: unknown): Promise<{ items: FollowRow[]; hasMore: boolean; next: number | null } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner || (type !== "followers" && type !== "following")) return null;
  const f = await col(C.follows);
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const rows = await f
    .find({ ...(type === "followers" ? { followeeId: owner._id } : { followerId: owner._id }), ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) })
    .sort({ createdAt: -1 })
    .limit(FOLLOW_PAGE + 1)
    .toArray();
  const page = rows.slice(0, FOLLOW_PAGE);
  const ids = page.map((r: any) => (type === "followers" ? r.followerId : r.followeeId) as number);
  const hidden = await hiddenOwnerIds(viewerId);
  const users = await usersCol();
  const docs = await users.find({ _id: { $in: ids.filter((i) => !hidden.includes(i)) }, onboardingStep: "COMPLETED", banned: { $ne: true } }).toArray();
  const byId = new Map(docs.map((d: any) => [d._id as number, d]));
  const ordered = ids.map((i) => byId.get(i)).filter(Boolean) as any[];
  const briefs = await toBriefs(viewerId, ordered);
  const mine = ordered.length ? await f.find({ _id: { $in: ordered.map((o) => `${viewerId}:${o._id}`) } }, { projection: { followeeId: 1 } }).toArray() : [];
  const iFollow = new Set(mine.map((m: any) => m.followeeId as number));
  const items = briefs.map((b, i) => ({ ...b, iFollow: iFollow.has(ordered[i]._id), isMe: ordered[i]._id === viewerId }));
  const hasMore = rows.length > FOLLOW_PAGE;
  return { items, hasMore, next: hasMore ? (page[page.length - 1] as any).createdAt.getTime() : null };
}
