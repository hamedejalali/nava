import { C, col, isId, toBriefs, usersCol, type Brief } from "./common.js";

/**
 * Activity ("heart") feed of the Mini App, like Instagram's: somebody liked your post / profile photo, followed you
 * (or asked to), commented, replied to your comment or liked it.
 *
 * Every notification has a DETERMINISTIC id, so repeating the same action (like → unlike → like, double tap, retry)
 * can never produce a second notification; undoing the action (unlike, unfollow, delete comment, delete post)
 * removes it again. Writing a notification is best-effort and never breaks the action that caused it.
 */

export type NotifType = "like_post" | "like_profile" | "follow" | "follow_request" | "accepted" | "comment" | "reply" | "like_comment" | "story_like" | "story_reply";

export interface NotifDoc {
  _id: string;
  userId: number; // who is told
  actorId: number; // who did it
  type: NotifType;
  postId?: string; // post id or "pp:<anonId>"
  commentId?: string;
  /** story notifications: the story and its picture */
  storyId?: string;
  mediaId?: string;
  text?: string;
  at: Date;
  seen: boolean;
}

export const NOTIF_PAGE = 30;
const KEEP_MS = 45 * 86_400_000;

export const notifKey = {
  likePost: (postId: string, actor: number) => `lp:${postId}:${actor}`,
  likeProfile: (owner: number, actor: number) => `lq:${owner}:${actor}`,
  follow: (actor: number, user: number) => `f:${actor}:${user}`,
  request: (actor: number, user: number) => `fr:${actor}:${user}`,
  accepted: (actor: number, user: number) => `fa:${actor}:${user}`,
  comment: (commentId: string) => `c:${commentId}`,
  reply: (commentId: string) => `r:${commentId}`,
  likeComment: (commentId: string, actor: number) => `lc:${commentId}:${actor}`,
  storyLike: (storyId: string, actor: number) => `sl:${storyId}:${actor}`,
  storyReply: (id: string) => `sr:${id}`,
};

export async function ensureNotifIndexes(db: { collection: (n: string) => { createIndexes: (i: any[]) => Promise<unknown> } }): Promise<void> {
  await db.collection(C.notifs).createIndexes([
    { key: { userId: 1, at: -1 }, name: "user_at" },
    { key: { userId: 1, seen: 1 }, name: "user_seen" },
    { key: { postId: 1 }, name: "post", partialFilterExpression: { postId: { $type: "string" } } },
    { key: { commentId: 1 }, name: "comment", partialFilterExpression: { commentId: { $type: "string" } } },
    { key: { storyId: 1 }, name: "story", partialFilterExpression: { storyId: { $type: "string" } } },
    { key: { at: 1 }, name: "ttl", expireAfterSeconds: Math.floor(KEEP_MS / 1000) },
  ]);
  await db.collection(C.commentLikes).createIndexes([{ key: { commentId: 1 }, name: "comment" }]);
}

export async function pushNotif(key: string, n: Omit<NotifDoc, "_id" | "at" | "seen">): Promise<void> {
  if (n.userId === n.actorId) return;
  try {
    const c = await col<NotifDoc>(C.notifs);
    await c.insertOne({ _id: key, ...n, at: new Date(), seen: false } as NotifDoc);
  } catch (err: any) {
    if (err?.code !== 11000) console.error("[notifs] push failed:", err instanceof Error ? err.name : "unknown");
  }
}

export async function dropNotifs(filter: Record<string, unknown>): Promise<void> {
  try {
    await (await col<NotifDoc>(C.notifs)).deleteMany(filter as any);
  } catch (err) {
    console.error("[notifs] drop failed:", err instanceof Error ? err.name : "unknown");
  }
}

export interface Pulse {
  total: number;
  likes: number;
  follows: number;
  comments: number;
}

/** Unread counts per group — one small query; the Mini App polls it every few seconds. */
export async function unreadCounts(userId: number): Promise<Pulse> {
  const rows = await (await col<NotifDoc>(C.notifs)).find({ userId, seen: false }, { projection: { type: 1 } }).limit(200).toArray();
  const p: Pulse = { total: rows.length, likes: 0, follows: 0, comments: 0 };
  for (const r of rows) {
    if (r.type === "like_post" || r.type === "like_profile" || r.type === "like_comment" || r.type === "story_like") p.likes++;
    else if (r.type === "follow" || r.type === "follow_request" || r.type === "accepted") p.follows++;
    else p.comments++;
  }
  return p;
}

export async function markNotifsSeen(userId: number): Promise<void> {
  await (await col<NotifDoc>(C.notifs)).updateMany({ userId, seen: false }, { $set: { seen: true } });
}

export interface NotifItem {
  id: string;
  type: NotifType;
  at: number;
  seen: boolean;
  actor: Brief;
  pid?: string;
  /** thumbnail of the post (turned into `src` by the presenter) */
  mediaId?: string | null;
  text?: string;
  commentId?: string;
  /** story rows: which story (it may already be gone — then there is no picture) */
  sid?: string;
  /** follow-type rows: my relation to the actor */
  iFollow?: boolean;
  requested?: boolean; // I asked them (private page) and wait
  pending?: boolean; // they asked me and I did not answer yet
  /** comment-type rows */
  liked?: boolean;
}

export async function listNotifs(viewerId: number, before?: unknown): Promise<{ items: NotifItem[]; hasMore: boolean; next: number | null }> {
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const c = await col<NotifDoc>(C.notifs);
  const docs = await c
    .find({ userId: viewerId, ...(beforeDate ? { at: { $lt: beforeDate } } : {}) })
    .sort({ at: -1 })
    .limit(NOTIF_PAGE + 1)
    .toArray();
  const page = docs.slice(0, NOTIF_PAGE);
  const users = await usersCol();
  const actors = await users.find({ _id: { $in: [...new Set(page.map((d) => d.actorId))] }, banned: { $ne: true } }).toArray();
  const briefs = await toBriefs(viewerId, actors);
  const by = new Map(actors.map((a: any, i: number) => [a._id as number, briefs[i]!]));

  const f = await col(C.follows);
  const reqs = await col(C.followRequests);
  const followIds = page.filter((d) => d.type === "follow" || d.type === "follow_request" || d.type === "accepted").map((d) => d.actorId);
  const iFollow = new Set((followIds.length ? await f.find({ _id: { $in: followIds.map((a) => `${viewerId}:${a}`) } }, { projection: { followeeId: 1 } }).toArray() : []).map((r: any) => r.followeeId as number));
  const iAsked = new Set((followIds.length ? await reqs.find({ _id: { $in: followIds.map((a) => `${viewerId}:${a}`) } }, { projection: { toId: 1 } }).toArray() : []).map((r: any) => r.toId as number));
  const pendingFrom = new Set((followIds.length ? await reqs.find({ toId: viewerId, fromId: { $in: followIds } }, { projection: { fromId: 1 } }).toArray() : []).map((r: any) => r.fromId as number));

  const postIds = [...new Set(page.filter((d) => d.postId && !d.postId.startsWith("pp:")).map((d) => d.postId!))];
  const posts = postIds.length ? await (await col(C.posts)).find({ _id: { $in: postIds } } as any, { projection: { mediaId: 1 } }).toArray() : [];
  const postMedia = new Map(posts.map((p: any) => [p._id as string, p.mediaId as string]));

  const commentIds = page.filter((d) => d.type === "comment" || d.type === "reply").map((d) => d.commentId!).filter(Boolean);
  const likedRows = commentIds.length ? await (await col(C.commentLikes)).find({ _id: { $in: commentIds.map((i) => `${i}:${viewerId}`) } }, { projection: { commentId: 1 } }).toArray() : [];
  const liked = new Set(likedRows.map((r: any) => r.commentId as string));
  const stillThere = commentIds.length ? new Set((await (await col(C.comments)).find({ _id: { $in: commentIds } }, { projection: { _id: 1 } }).toArray()).map((r: any) => r._id as string)) : new Set<string>();

  const items: NotifItem[] = [];
  for (const d of page) {
    const actor = by.get(d.actorId);
    if (!actor) continue;
    if ((d.type === "comment" || d.type === "reply") && d.commentId && !stillThere.has(d.commentId)) continue; // deleted meanwhile
    const it: NotifItem = { id: d._id, type: d.type, at: d.at.getTime(), seen: d.seen, actor };
    if (d.postId) {
      it.pid = d.postId;
      if (!d.postId.startsWith("pp:")) it.mediaId = postMedia.get(d.postId) ?? null;
    }
    if (d.text) it.text = d.text;
    if (d.storyId) {
      it.sid = d.storyId;
      it.mediaId = d.mediaId ?? null;
    }
    if (d.commentId) it.commentId = d.commentId;
    if (d.type === "follow" || d.type === "follow_request" || d.type === "accepted") {
      it.iFollow = iFollow.has(d.actorId);
      it.requested = iAsked.has(d.actorId);
      it.pending = d.type === "follow_request" && pendingFrom.has(d.actorId);
    }
    if (d.type === "comment" || d.type === "reply") it.liked = !!d.commentId && liked.has(d.commentId);
    items.push(it);
  }
  return { items, hasMore: docs.length > NOTIF_PAGE, next: page.length ? page[page.length - 1]!.at.getTime() : null };
}

export { isId };
