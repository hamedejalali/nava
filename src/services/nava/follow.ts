import { env } from "../../config/env.js";
import { dropNotifs, notifKey, pushNotif } from "./notifs.js";
import { C, SocialError, col, findVisibleUser, hiddenOwnerIds, isAnonId, lockedOwnerIds, toBriefs, usersCol, type Brief } from "./common.js";

export const FOLLOW_PAGE = 30;

export async function followCounts(userId: number): Promise<{ followers: number; following: number }> {
  const f = await col(C.follows);
  return { followers: await f.countDocuments({ followeeId: userId }), following: await f.countDocuments({ followerId: userId }) };
}

export interface FollowResult {
  following: boolean;
  followers: number;
  /** only present (true) when the target has a PRIVATE page and the request is waiting for their approval */
  requested?: true;
}

/**
 * Idempotent: following twice counts once, unfollowing twice is a no-op.
 * A PRIVATE page cannot be followed directly: the first "follow" creates a request the owner approves or
 * declines (see respondFollowRequest); tapping again (or unfollowing) cancels the request.
 */
export async function setFollow(viewer: any, anonId: unknown, follow: boolean): Promise<FollowResult | null> {
  if (anonId === viewer.anonId) throw new SocialError("self");
  const target = await findVisibleUser(viewer._id, anonId);
  if (!target) return null;
  const f = await col(C.follows);
  const reqs = await col(C.followRequests);
  const key = `${viewer._id}:${target._id}`;
  if (follow) {
    const already = await f.findOne({ _id: key });
    if (!already && target.isPrivate) {
      try {
        await reqs.insertOne({ _id: key, fromId: viewer._id, toId: target._id, createdAt: new Date() });
        await pushNotif(notifKey.request(viewer._id, target._id), { userId: target._id, actorId: viewer._id, type: "follow_request" });
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // already requested: counted once
      }
      return { following: false, followers: await f.countDocuments({ followeeId: target._id }), requested: true };
    }
    try {
      await f.insertOne({ _id: key, followerId: viewer._id, followeeId: target._id, createdAt: new Date() });
      await pushNotif(notifKey.follow(viewer._id, target._id), { userId: target._id, actorId: viewer._id, type: "follow" });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  } else {
    await f.deleteOne({ _id: key });
    await reqs.deleteOne({ _id: key });
    await dropNotifs({ _id: { $in: [notifKey.follow(viewer._id, target._id), notifKey.request(viewer._id, target._id)] } });
  }
  const pending = !!(await reqs.findOne({ _id: key }));
  return { following: !!(await f.findOne({ _id: key })), followers: await f.countDocuments({ followeeId: target._id }), ...(pending ? { requested: true as const } : {}) };
}

export interface FollowRow extends Brief {
  iFollow: boolean;
  isMe: boolean;
}

export async function listFollows(viewerId: number, anonId: unknown, type: unknown, before?: unknown): Promise<{ items: FollowRow[]; hasMore: boolean; next: number | null; locked?: boolean } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner || (type !== "followers" && type !== "following")) return null;
  // a private page's follower / following lists are for approved followers only
  if ((await lockedOwnerIds(viewerId)).includes(owner._id)) return { items: [], hasMore: false, next: null, locked: true };
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

/* ------------------------------------------------------- private pages */

export async function countFollowRequests(ownerId: number): Promise<number> {
  return (await col(C.followRequests)).countDocuments({ toId: ownerId });
}

/** Follow requests waiting for ME (newest first). */
export async function listFollowRequests(me: any, before?: unknown): Promise<{ items: Brief[]; hasMore: boolean; next: number | null; total: number }> {
  const reqs = await col(C.followRequests);
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const rows = await reqs
    .find({ toId: me._id, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) })
    .sort({ createdAt: -1 })
    .limit(FOLLOW_PAGE + 1)
    .toArray();
  const page = rows.slice(0, FOLLOW_PAGE);
  const hidden = await hiddenOwnerIds(me._id);
  const users = await usersCol();
  const docs = await users.find({ _id: { $in: page.map((r: any) => r.fromId).filter((i: number) => !hidden.includes(i)) }, onboardingStep: "COMPLETED", banned: { $ne: true } }).toArray();
  const by = new Map(docs.map((d: any) => [d._id as number, d]));
  const ordered = page.map((r: any) => by.get(r.fromId)).filter(Boolean) as any[];
  const hasMore = rows.length > FOLLOW_PAGE;
  return { items: await toBriefs(me._id, ordered), hasMore, next: hasMore ? (page[page.length - 1] as any).createdAt.getTime() : null, total: await reqs.countDocuments({ toId: me._id }) };
}

/** Approve (→ they become my follower) or decline a request. Atomic: the request document is claimed first, so
 *  two simultaneous taps / a request cancelled meanwhile can never create a follow twice or out of nothing. */
export async function respondFollowRequest(me: any, anonId: unknown, accept: boolean): Promise<{ status: "accepted" | "declined" | "gone"; followers: number; requests: number }> {
  if (!isAnonId(anonId)) throw new SocialError("not_found");
  const users = await usersCol();
  const from = await users.findOne({ anonId, onboardingStep: "COMPLETED" }, { projection: { _id: 1 } });
  const reqs = await col(C.followRequests);
  const f = await col(C.follows);
  let status: "accepted" | "declined" | "gone" = "gone";
  if (from) {
    const claimed = await reqs.findOneAndDelete({ _id: `${from._id}:${me._id}`, toId: me._id });
    if (claimed) {
      status = accept ? "accepted" : "declined";
      await dropNotifs({ _id: notifKey.request(from._id, me._id) });
      if (accept) {
        try {
          await f.insertOne({ _id: `${from._id}:${me._id}`, followerId: from._id, followeeId: me._id, createdAt: new Date() });
          await pushNotif(notifKey.follow(from._id, me._id), { userId: me._id, actorId: from._id, type: "follow" });
        } catch (err: any) {
          if (err?.code !== 11000) throw err;
        }
        await pushNotif(notifKey.accepted(me._id, from._id), { userId: from._id, actorId: me._id, type: "accepted" });
      }
    }
  }
  return { status, followers: await f.countDocuments({ followeeId: me._id }), requests: await reqs.countDocuments({ toId: me._id }) };
}

/** Switch my page private/public. Going public approves everybody who was waiting (like Instagram). */
export async function setPrivate(me: any, on: boolean): Promise<{ isPrivate: boolean; requests: number; followers: number }> {
  const users = await usersCol();
  await users.updateOne({ _id: me._id }, { $set: { isPrivate: on } });
  const reqs = await col(C.followRequests);
  const f = await col(C.follows);
  if (!on) {
    for (let round = 0; round < 40; round++) {
      const batch = await reqs.find({ toId: me._id }).limit(250).toArray();
      if (!batch.length) break;
      for (const r of batch) {
        try {
          await f.insertOne({ _id: r._id, followerId: r.fromId, followeeId: me._id, createdAt: new Date() });
        } catch (err: any) {
          if (err?.code !== 11000) throw err;
        }
        await reqs.deleteOne({ _id: r._id });
        await pushNotif(notifKey.follow(r.fromId, me._id), { userId: me._id, actorId: r.fromId, type: "follow" });
        await pushNotif(notifKey.accepted(me._id, r.fromId), { userId: r.fromId, actorId: me._id, type: "accepted" });
      }
    }
    await dropNotifs({ userId: me._id, type: "follow_request" });
  }
  return { isPrivate: on, requests: await reqs.countDocuments({ toId: me._id }), followers: await f.countDocuments({ followeeId: me._id }) };
}

/**
 * Everybody follows the official account (the owner's «Nava») from the first time they open the Mini App.
 * Done ONCE per person (`navaFollowed`), so unfollowing is respected; it creates no "X followed you" notification.
 */
export async function ensureOfficialFollow(user: any): Promise<void> {
  if (!user || user.navaFollowed || user.isSeed || env.OWNER_ID === undefined || user._id === env.OWNER_ID) return;
  const users = await usersCol();
  const owner = await users.findOne({ _id: env.OWNER_ID, onboardingStep: "COMPLETED" }, { projection: { _id: 1 } });
  if (!owner) return;
  const f = await col(C.follows);
  try {
    await f.insertOne({ _id: `${user._id}:${owner._id}`, followerId: user._id, followeeId: owner._id, createdAt: new Date(), auto: true });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  await users.updateOne({ _id: user._id }, { $set: { navaFollowed: true } });
}
