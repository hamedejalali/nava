import { InputFile, type Api } from "grammy";
import { escapeHtml } from "../../utils/html.js";
import { botApi } from "../miniapp.js";
import { C, DAY_MS, SocialError, col, cleanText, findVisibleUser, hiddenOwnerIds, isId, isStaffId, lockedOwnerIds, newId, parsePid, photoVer, toBriefs, usersCol, visibleUserFilter, type Brief } from "./common.js";
import { decodeImage, deleteMedia, storeMedia } from "./media.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { getMiniSettings } from "./settings.js";

export const MAX_CAPTION = 1000;
export const MAX_COMMENT = 500;
export const MAX_POSTS_PER_DAY = 30;
export const COMMENTS_PER_MINUTE = 10;
export const FEED_PAGE = 8;
export const GRID_PAGE = 24;
export const COMMENT_PAGE = 30;

export interface PostDoc {
  _id: string;
  ownerId: number;
  mediaId: string;
  caption: string;
  createdAt: Date;
  likesCount: number;
  commentsCount: number;
  channelMsgId?: number | null;
  /** width / height of the picture (4:5 = 0.8, 1:1 = 1, 1.91:1) so the feed never jumps while loading */
  ar?: number;
  /** Instagram's "turn off commenting" / "hide like count" options */
  noComments?: boolean;
  hideLikes?: boolean;
}

export interface FeedItem {
  pid: string; // post id, or "pp:<anonId>" for the profile-photo post
  kind: "post" | "profile";
  owner: Brief;
  mediaId: string | null; // null for the profile post (its image is the owner's current profile photo)
  pv: string | null;
  caption: string;
  at: number;
  likes: number;
  liked: boolean;
  comments: number;
  mine: boolean;
  ar: number;
  noComments: boolean;
  hideLikes: boolean;
}

export const RATIOS: Record<string, number> = { "4:5": 0.8, "1:1": 1, "1.91:1": 1.91 };

type ApiLike = Pick<Api, "sendPhoto">;

/* ---------------------------------------------------------------- build */

async function likedPostIds(viewerId: number, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const likes = await col(C.postLikes);
  const rows = await likes.find({ _id: { $in: ids.map((i) => `${i}:${viewerId}`) } }, { projection: { postId: 1 } }).toArray();
  return new Set(rows.map((r: any) => String(r.postId)));
}
async function likedProfiles(viewerId: number, targetIds: number[]): Promise<Set<number>> {
  if (!targetIds.length) return new Set();
  const likes = await col("profile_likes");
  const rows = await likes.find({ _id: { $in: targetIds.map((t) => `${viewerId}:${t}`) } }, { projection: { _id: 1 } }).toArray();
  return new Set(rows.map((r: any) => Number(String(r._id).split(":")[1])));
}

export async function postsToItems(viewerId: number, posts: PostDoc[]): Promise<FeedItem[]> {
  if (!posts.length) return [];
  const users = await usersCol();
  const ownerIds = [...new Set(posts.map((p) => p.ownerId))];
  const owners = await users.find({ _id: { $in: ownerIds } }).toArray();
  const briefs = await toBriefs(viewerId, owners);
  const briefBy = new Map(owners.map((o: any, i: number) => [o._id as number, briefs[i]!]));
  const liked = await likedPostIds(viewerId, posts.map((p) => p._id));
  return posts
    .filter((p) => briefBy.has(p.ownerId))
    .map((p) => ({
      pid: p._id,
      kind: "post" as const,
      owner: briefBy.get(p.ownerId)!,
      mediaId: p.mediaId,
      pv: null,
      caption: p.caption ?? "",
      at: p.createdAt.getTime(),
      // with "hide like count" on, other people get no number at all
      likes: p.hideLikes && p.ownerId !== viewerId ? 0 : (p.likesCount ?? 0),
      liked: liked.has(p._id),
      comments: p.commentsCount ?? 0,
      mine: p.ownerId === viewerId,
      ar: p.ar ?? 0.8,
      noComments: !!p.noComments,
      hideLikes: !!p.hideLikes,
    }));
}

export async function profilesToItems(viewerId: number, owners: any[]): Promise<FeedItem[]> {
  if (!owners.length) return [];
  const briefs = await toBriefs(viewerId, owners);
  const liked = await likedProfiles(viewerId, owners.map((o) => o._id));
  return owners.map((o, i) => ({
    pid: `pp:${o.anonId}`,
    kind: "profile" as const,
    owner: briefs[i]!,
    mediaId: null,
    pv: photoVer(o.profilePhotoFileId),
    caption: "",
    at: (o.profilePhotoAt ?? o.createdAt ?? new Date(0)).getTime(),
    likes: o.likesCount ?? 0,
    liked: liked.has(o._id),
    comments: o.profileCommentsCount ?? 0,
    mine: o._id === viewerId,
    ar: 1,
    noComments: false,
    hideLikes: false,
  }));
}

/* ----------------------------------------------------------------- feed */

export async function listFeed(viewerId: number, before?: unknown, limit = FEED_PAGE): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  // private pages the viewer is not approved for are left out of the feed (posts and profile-photo posts)
  const hidden = [...(await hiddenOwnerIds(viewerId)), ...(await lockedOwnerIds(viewerId))];
  const posts = await col<PostDoc>(C.posts);
  const users = await usersCol();

  const postDocs = await posts
    .find({ ownerId: { $nin: hidden }, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) } as any)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .toArray();
  const profDocs = await users
    .find({
      ...visibleUserFilter(viewerId, hidden, { includeSelf: true }),
      profilePhotoFileId: { $type: "string", $ne: "" },
      ...(beforeDate ? { profilePhotoAt: { $lt: beforeDate } } : {}),
    })
    .sort({ profilePhotoAt: -1 })
    .limit(limit + 1)
    .toArray();

  const merged = [...(await postsToItems(viewerId, postDocs)), ...(await profilesToItems(viewerId, profDocs))].sort((a, b) => b.at - a.at);
  return { items: merged.slice(0, limit), hasMore: merged.length > limit };
}

export async function getPostItem(viewerId: number, pidRaw: unknown): Promise<FeedItem | null> {
  const pid = parsePid(pidRaw);
  if (!pid) return null;
  if (pid.kind === "profile") {
    const owner = await findVisibleUser(viewerId, pid.anonId, { includeSelf: true });
    if (!owner || !owner.profilePhotoFileId) return null;
    if ((await lockedOwnerIds(viewerId)).includes(owner._id)) return null;
    return (await profilesToItems(viewerId, [owner]))[0] ?? null;
  }
  const hidden = [...(await hiddenOwnerIds(viewerId, { direct: true })), ...(await lockedOwnerIds(viewerId))];
  const posts = await col<PostDoc>(C.posts);
  const post = await posts.findOne({ _id: pid.id, ownerId: { $nin: hidden } } as any);
  return post ? ((await postsToItems(viewerId, [post]))[0] ?? null) : null;
}

export interface GridItem {
  pid: string;
  mediaId: string | null;
  pv: string | null;
  likes: number;
  comments: number;
  at?: number;
}

/** Newest posts first; the profile-photo post is ALWAYS the last (= first ever) tile. */
export async function listUserPosts(viewerId: number, anonId: unknown, before?: unknown): Promise<{ items: GridItem[]; hasMore: boolean; locked?: boolean } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner) return null;
  if ((await lockedOwnerIds(viewerId)).includes(owner._id)) return { items: [], hasMore: false, locked: true };
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const posts = await col<PostDoc>(C.posts);
  const docs = await posts
    .find({ ownerId: owner._id, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) } as any)
    .sort({ createdAt: -1 })
    .limit(GRID_PAGE + 1)
    .toArray();
  const hasMorePosts = docs.length > GRID_PAGE;
  const items: GridItem[] = docs.slice(0, GRID_PAGE).map((p) => ({
    pid: p._id,
    mediaId: p.mediaId,
    pv: null,
    likes: p.likesCount ?? 0,
    comments: p.commentsCount ?? 0,
    at: p.createdAt.getTime(),
  }));
  if (!hasMorePosts && owner.profilePhotoFileId) {
    items.push({ pid: `pp:${owner.anonId}`, mediaId: null, pv: photoVer(owner.profilePhotoFileId), likes: owner.likesCount ?? 0, comments: owner.profileCommentsCount ?? 0 });
  }
  return { items, hasMore: hasMorePosts };
}

export async function countPosts(owner: any): Promise<number> {
  const posts = await col(C.posts);
  return (await posts.countDocuments({ ownerId: owner._id })) + (owner.profilePhotoFileId ? 1 : 0);
}

/* ---------------------------------------------------------- create/edit */

async function copyToChannel(api: ApiLike, owner: any, post: PostDoc, buf: Buffer): Promise<void> {
  const s = await getMiniSettings();
  if (!s.postsChannelEnabled || !s.postsChannelId) return;
  try {
    const name = escapeHtml(owner.nickname ?? "-");
    const un = owner.miniUsername ? ` (@${escapeHtml(owner.miniUsername)})` : "";
    const head = `📸 <b>پست جدید — نوا گرام</b>\n👤 ${name}${un}\n🆔 <code>${escapeHtml(owner.anonId)}</code>`;
    let caption = post.caption ? `${head}\n\n${escapeHtml(post.caption)}` : head;
    if (caption.length > 1000) caption = caption.slice(0, 997) + "…";
    const sent = await api.sendPhoto(s.postsChannelId, new InputFile(buf, "post.jpg"), { caption, parse_mode: "HTML" });
    const posts = await col<PostDoc>(C.posts);
    await posts.updateOne({ _id: post._id }, { $set: { channelMsgId: (sent as any)?.message_id ?? null } });
  } catch (err) {
    console.error("[navagram] channel copy failed:", err instanceof Error ? err.message : "unknown");
  }
}

export interface PostOptions {
  ratio?: unknown;
  noComments?: unknown;
  hideLikes?: unknown;
}

export async function createPost(owner: any, imageRaw: unknown, captionRaw: unknown, deps: { api?: ApiLike } = {}, opts: PostOptions = {}): Promise<FeedItem> {
  const caption = captionRaw == null || captionRaw === "" ? "" : cleanText(captionRaw, MAX_CAPTION, { multiline: true });
  const buf = decodeImage(imageRaw);
  const posts = await col<PostDoc>(C.posts);
  const recent = await posts.countDocuments({ ownerId: owner._id, createdAt: { $gt: new Date(Date.now() - DAY_MS) } });
  if (recent >= MAX_POSTS_PER_DAY) throw new SocialError("too_many");
  const mediaId = await storeMedia(owner._id, "post", buf);
  const ar = typeof opts.ratio === "string" && RATIOS[opts.ratio] ? RATIOS[opts.ratio]! : 0.8;
  const post: PostDoc = {
    _id: newId(), ownerId: owner._id, mediaId, caption, createdAt: new Date(), likesCount: 0, commentsCount: 0, channelMsgId: null,
    ar, noComments: opts.noComments === true, hideLikes: opts.hideLikes === true,
  };
  await posts.insertOne(post as any);
  await copyToChannel(deps.api ?? botApi(), owner, post, buf);
  return (await postsToItems(owner._id, [post]))[0]!;
}

export async function editCaption(owner: any, pidRaw: unknown, captionRaw: unknown): Promise<string> {
  const pid = parsePid(pidRaw);
  if (!pid || pid.kind !== "post") throw new SocialError("not_found");
  const caption = captionRaw == null || captionRaw === "" ? "" : cleanText(captionRaw, MAX_CAPTION, { multiline: true });
  const posts = await col<PostDoc>(C.posts);
  const r = await posts.updateOne({ _id: pid.id, ownerId: owner._id } as any, { $set: { caption } });
  if (r.matchedCount !== 1) throw new SocialError("not_found");
  return caption;
}

/** Caption and/or the two Instagram switches — owner only. Returns what is stored now. */
export async function editPost(owner: any, pidRaw: unknown, input: { caption?: unknown; noComments?: unknown; hideLikes?: unknown }): Promise<{ caption: string; noComments: boolean; hideLikes: boolean }> {
  const pid = parsePid(pidRaw);
  if (!pid || pid.kind !== "post") throw new SocialError("not_found");
  const set: Record<string, unknown> = {};
  if (input.caption !== undefined) set.caption = input.caption == null || input.caption === "" ? "" : cleanText(input.caption, MAX_CAPTION, { multiline: true });
  if (typeof input.noComments === "boolean") set.noComments = input.noComments;
  if (typeof input.hideLikes === "boolean") set.hideLikes = input.hideLikes;
  const posts = await col<PostDoc>(C.posts);
  if (Object.keys(set).length) {
    const r = await posts.updateOne({ _id: pid.id, ownerId: owner._id } as any, { $set: set });
    if (r.matchedCount !== 1) throw new SocialError("not_found");
  }
  const post = await posts.findOne({ _id: pid.id, ownerId: owner._id } as any);
  if (!post) throw new SocialError("not_found");
  return { caption: post.caption ?? "", noComments: !!post.noComments, hideLikes: !!post.hideLikes };
}

export async function deletePost(owner: any, pidRaw: unknown, opts: { asStaff?: boolean } = {}): Promise<{ ownerId: number } | void> {
  const pid = parsePid(pidRaw);
  if (!pid || pid.kind !== "post") throw new SocialError("not_found");
  const posts = await col<PostDoc>(C.posts);
  const post = await posts.findOne(opts.asStaff ? ({ _id: pid.id } as any) : ({ _id: pid.id, ownerId: owner._id } as any));
  if (!post) throw new SocialError("not_found");
  await removePost(post);
  return { ownerId: post.ownerId };
}

/** Removes a post with everything attached to it (likes, comments, picture, its single channel copy). */
export async function removePost(post: PostDoc): Promise<void> {
  const posts = await col<PostDoc>(C.posts);
  await posts.deleteOne({ _id: post._id } as any);
  await (await col(C.postLikes)).deleteMany({ postId: post._id });
  await (await col(C.comments)).deleteMany({ postId: post._id });
  await deleteMedia([post.mediaId]);
  // The post is gone, so its single copy in the channel goes too (best effort).
  if (post.channelMsgId) {
    try {
      const s = await getMiniSettings();
      if (s.postsChannelId) await botApi().deleteMessage(s.postsChannelId, post.channelMsgId);
    } catch {
      /* already deleted / no permission */
    }
  }
}

/* ---------------------------------------------------------------- likes */

export async function setPostLike(viewer: any, pidRaw: unknown, like: boolean): Promise<{ liked: boolean; likes: number } | null> {
  const pid = parsePid(pidRaw);
  if (!pid || pid.kind !== "post") return null;
  const hidden = [...(await hiddenOwnerIds(viewer._id)), ...(await lockedOwnerIds(viewer._id))];
  const posts = await col<PostDoc>(C.posts);
  const post = await posts.findOne({ _id: pid.id, ownerId: { $nin: hidden } } as any);
  if (!post) return null;
  const likes = await col(C.postLikes);
  const key = `${post._id}:${viewer._id}`;
  // The like document and the counter change in ONE transaction: a crash can no longer leave one without
  // the other, and concurrent like/unlike/double-tap serialize on the like document (the loser retries
  // and finds the new state), so the counter always equals the number of like documents.
  try {
    await runInTransaction(async (session) => {
      if (like) {
        const r = await likes.updateOne({ _id: key }, { $setOnInsert: { postId: post._id, userId: viewer._id, createdAt: new Date() } }, { upsert: true, session });
        if (r.upsertedCount !== 1) return; // already liked: nothing to count
        const inc = await posts.updateOne({ _id: post._id } as any, { $inc: { likesCount: 1 } }, { session });
        if (inc.matchedCount !== 1) throw new TxAbort("post_gone"); // deleted meanwhile: no orphan like
      } else {
        const r = await likes.deleteOne({ _id: key }, { session });
        if (r.deletedCount === 1) await posts.updateOne({ _id: post._id, likesCount: { $gt: 0 } } as any, { $inc: { likesCount: -1 } }, { session });
      }
    });
  } catch (err: any) {
    if (err instanceof TxAbort) return null;
    if (err?.code !== 11000) throw err; // a concurrent identical like won the race: it was counted exactly once
  }
  const fresh = await posts.findOne({ _id: post._id } as any);
  return { liked: !!(await likes.findOne({ _id: key })), likes: fresh?.hideLikes && post.ownerId !== viewer._id ? 0 : (fresh?.likesCount ?? 0) };
}

/* ------------------------------------------------------------- comments */

export interface CommentView {
  id: string;
  text: string;
  at: number;
  user: Brief;
  canDelete: boolean;
}

async function resolvePostTarget(viewerId: number, pidRaw: unknown): Promise<{ pid: string; ownerId: number; kind: "post" | "profile" } | null> {
  const pid = parsePid(pidRaw);
  if (!pid) return null;
  if (pid.kind === "profile") {
    const owner = await findVisibleUser(viewerId, pid.anonId, { includeSelf: true });
    if (owner && (await lockedOwnerIds(viewerId)).includes(owner._id)) return null;
    return owner && owner.profilePhotoFileId ? { pid: `pp:${owner.anonId}`, ownerId: owner._id, kind: "profile" } : null;
  }
  const hidden = [...(await hiddenOwnerIds(viewerId, { direct: true })), ...(await lockedOwnerIds(viewerId))];
  const posts = await col<PostDoc>(C.posts);
  const post = await posts.findOne({ _id: pid.id, ownerId: { $nin: hidden } } as any);
  return post ? { pid: post._id, ownerId: post.ownerId, kind: "post" } : null;
}

export async function listComments(viewerId: number, pidRaw: unknown, before?: unknown): Promise<{ items: CommentView[]; hasMore: boolean } | null> {
  const target = await resolvePostTarget(viewerId, pidRaw);
  if (!target) return null;
  const hidden = await hiddenOwnerIds(viewerId, { direct: true });
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const comments = await col(C.comments);
  const docs = await comments
    .find({ postId: target.pid, ownerId: { $nin: hidden }, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) })
    .sort({ createdAt: -1 })
    .limit(COMMENT_PAGE + 1)
    .toArray();
  const page = docs.slice(0, COMMENT_PAGE);
  return { items: await commentsToViews(viewerId, target.ownerId, page), hasMore: docs.length > COMMENT_PAGE };
}

async function commentsToViews(viewerId: number, postOwnerId: number, docs: any[]): Promise<CommentView[]> {
  const users = await usersCol();
  const authors = await users.find({ _id: { $in: [...new Set(docs.map((d) => d.ownerId))] } }).toArray();
  const briefs = await toBriefs(viewerId, authors);
  const by = new Map(authors.map((a: any, i: number) => [a._id as number, briefs[i]!]));
  return docs
    .filter((d) => by.has(d.ownerId))
    .map((d) => ({ id: d._id, text: d.text, at: d.createdAt.getTime(), user: by.get(d.ownerId)!, canDelete: d.ownerId === viewerId || postOwnerId === viewerId || isStaffId(viewerId) }));
}

/** Must run inside the same transaction as the comment insert/delete it accompanies. Returns false when the
 *  target no longer exists (post deleted meanwhile) for an increment. */
async function bumpCommentCount(target: { pid: string; ownerId: number; kind: "post" | "profile" }, delta: 1 | -1, session: import("mongodb").ClientSession): Promise<boolean> {
  if (target.kind === "post") {
    const posts = await col<PostDoc>(C.posts);
    const r = await posts.updateOne(delta < 0 ? ({ _id: target.pid, commentsCount: { $gt: 0 } } as any) : ({ _id: target.pid } as any), { $inc: { commentsCount: delta } }, { session });
    return delta < 0 || r.matchedCount === 1;
  }
  const users = await usersCol();
  const r = await users.updateOne(delta < 0 ? { _id: target.ownerId, profileCommentsCount: { $gt: 0 } } : { _id: target.ownerId }, { $inc: { profileCommentsCount: delta } }, { session });
  return delta < 0 || r.matchedCount === 1;
}

export async function addComment(viewer: any, pidRaw: unknown, textRaw: unknown): Promise<{ comment: CommentView; comments: number }> {
  const text = cleanText(textRaw, MAX_COMMENT, { multiline: false, min: 1 });
  const target = await resolvePostTarget(viewer._id, pidRaw);
  if (!target) throw new SocialError("not_found");
  if (target.kind === "post") {
    const post = await (await col<PostDoc>(C.posts)).findOne({ _id: target.pid } as any);
    if (post?.noComments) throw new SocialError("comments_off");
  }
  const comments = await col(C.comments);
  const recent = await comments.countDocuments({ ownerId: viewer._id, createdAt: { $gt: new Date(Date.now() - 60_000) } });
  if (recent >= COMMENTS_PER_MINUTE) throw new SocialError("too_fast");
  const doc = { _id: newId(), postId: target.pid, ownerId: viewer._id, text, createdAt: new Date() };
  try {
    await runInTransaction(async (session) => {
      await comments.insertOne(doc, { session });
      if (!(await bumpCommentCount(target, 1, session))) throw new TxAbort("target_gone"); // no orphan comment
    });
  } catch (err) {
    if (err instanceof TxAbort) throw new SocialError("not_found");
    throw err;
  }
  const view = (await commentsToViews(viewer._id, target.ownerId, [doc]))[0]!;
  return { comment: view, comments: await commentCount(target) };
}

async function commentCount(target: { pid: string; ownerId: number; kind: "post" | "profile" }): Promise<number> {
  if (target.kind === "post") return ((await (await col<PostDoc>(C.posts)).findOne({ _id: target.pid } as any))?.commentsCount ?? 0);
  return ((await (await usersCol()).findOne({ _id: target.ownerId }))?.profileCommentsCount ?? 0);
}

/** Allowed for the commenter and for the owner of the page/post. */
export async function deleteComment(viewer: any, commentId: unknown, opts: { asStaff?: boolean } = {}): Promise<{ comments: number }> {
  if (!isId(commentId)) throw new SocialError("not_found");
  const comments = await col(C.comments);
  const doc = await comments.findOne({ _id: commentId });
  if (!doc) throw new SocialError("not_found");
  const target = await resolvePostTarget(viewer._id, doc.postId);
  if (!target) throw new SocialError("not_found");
  if (!opts.asStaff && doc.ownerId !== viewer._id && target.ownerId !== viewer._id) throw new SocialError("forbidden");
  await runInTransaction(async (session) => {
    const r = await comments.deleteOne({ _id: commentId }, { session });
    if (r.deletedCount === 1) await bumpCommentCount(target, -1, session);
  });
  return { comments: await commentCount(target) };
}
