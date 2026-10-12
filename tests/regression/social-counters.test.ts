/** Defect E: like / comment counters stay equal to the documents they count (crashes, double taps, races). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const P = await import("../../src/services/nava/posts.js");
const M = await import("../../src/services/miniappSocial.js");
const { getClient } = await import("../../src/db/connect.js");

const PID = "post_abc123";
beforeEach(async () => {
  resetFakeMongo();
  for (let i = 1; i <= 8; i++) seedUser({ id: i, anonId: `user_AAA${i}` } as any);
  await col("mini_posts").insertOne({ _id: PID, ownerId: 1, mediaId: "m", caption: "", createdAt: new Date(), likesCount: 0, commentsCount: 0, channelMsgId: null } as any);
});

const viewer = (id: number) => col("users").byId(id);
const post = () => col("mini_posts").byId(PID);
const likeDocs = () => col("mini_post_likes").all().length;

test("E1. a double tap / duplicate like counts once; unlike twice un-counts once; never negative", async () => {
  await Promise.all([P.setPostLike(viewer(2), PID, true), P.setPostLike(viewer(2), PID, true), P.setPostLike(viewer(2), PID, true)]);
  assert.equal(post().likesCount, 1);
  assert.equal(likeDocs(), 1);
  await Promise.all([P.setPostLike(viewer(2), PID, false), P.setPostLike(viewer(2), PID, false)]);
  assert.equal(post().likesCount, 0);
  assert.equal(likeDocs(), 0);
  await P.setPostLike(viewer(2), PID, false);
  assert.equal(post().likesCount, 0);
});

test("E2. many users liking / unliking concurrently: the counter always equals the number of like documents", async () => {
  const ops: Promise<unknown>[] = [];
  for (let round = 0; round < 6; round++) for (let u = 2; u <= 8; u++) ops.push(P.setPostLike(viewer(u), PID, (u + round) % 3 !== 0));
  await Promise.all(ops);
  assert.equal(post().likesCount, likeDocs());
  assert.ok(post().likesCount >= 0);
});

test("E3. like racing with its own unlike (same user) ends consistent", async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.all([P.setPostLike(viewer(2), PID, true), P.setPostLike(viewer(2), PID, false), P.setPostLike(viewer(2), PID, true)]);
    assert.equal(post().likesCount, likeDocs(), `round ${i}`);
  }
});

test("E4. a failure between the like document and the counter rolls BOTH back (no drift) and a retry succeeds", async () => {
  const client: any = await getClient();
  const real = client.startSession.bind(client);
  const posts = col("mini_posts") as any;
  const origUpdate = posts.updateOne.bind(posts);
  let boom = true;
  posts.updateOne = async (...a: any[]) => {
    if (boom) { boom = false; throw new Error("simulated Mongo outage"); }
    return origUpdate(...a);
  };
  try {
    await assert.rejects(P.setPostLike(viewer(2), PID, true));
  } finally {
    posts.updateOne = origUpdate;
    client.startSession = real;
  }
  assert.equal(likeDocs(), 0, "no orphan like document");
  assert.equal(post().likesCount, 0);
  await P.setPostLike(viewer(2), PID, true);
  assert.equal(post().likesCount, 1);
  assert.equal(likeDocs(), 1);
});

test("E5. liking a post that was deleted in the meantime leaves no orphan like", async () => {
  await col("mini_posts").deleteOne({ _id: PID });
  const r = await P.setPostLike(viewer(2), PID, true);
  assert.equal(r, null);
  assert.equal(likeDocs(), 0);
});

test("E6. comments: counter == number of comments under concurrent add/delete; owner/author rules are kept", async () => {
  // keep within the per-minute limit
  const adds = await Promise.all([2, 3, 4, 5].map((u) => P.addComment(viewer(u), PID, `hello ${u}`)));
  assert.equal(post().commentsCount, 4);
  assert.equal(col("mini_comments").all().length, 4);
  const mine = adds[0]!.comment.id; // authored by user 2
  await assert.rejects(P.deleteComment(viewer(3), mine), (e: any) => e.code === "forbidden"); // a stranger can not
  await Promise.all([P.deleteComment(viewer(2), mine), P.deleteComment(viewer(1), mine).catch(() => {})]); // author + post owner racing
  assert.equal(col("mini_comments").all().length, 3);
  assert.equal(post().commentsCount, 3, "double delete decrements once");
  await P.deleteComment(viewer(1), adds[1]!.comment.id); // the post owner may delete anyone's
  assert.equal(post().commentsCount, 2);
});

test("E7. commenting on a deleted post is refused and leaves no orphan comment", async () => {
  await col("mini_posts").deleteOne({ _id: PID });
  await assert.rejects(P.addComment(viewer(2), PID, "x"), (e: any) => e.code === "not_found");
  assert.equal(col("mini_comments").all().length, 0);
});

test("E8. profile likes (mini-app) are atomic and idempotent too", async () => {
  const target = viewer(1).anonId;
  await Promise.all([M.setLike(viewer(2), target, true), M.setLike(viewer(2), target, true), M.setLike(viewer(3), target, true)]);
  assert.equal(viewer(1).likesCount, 2);
  assert.equal(col("profile_likes").all().length, 2);
  await Promise.all([M.setLike(viewer(2), target, false), M.setLike(viewer(2), target, false)]);
  assert.equal(viewer(1).likesCount, 1);
});

test("F1. explore: one very active user's posts can not crowd out other users' latest posts on the same page", async () => {
  resetFakeMongo();
  const { explore } = await import("../../src/services/nava/search.js");
  for (let i = 1; i <= 6; i++) seedUser({ id: i, anonId: `user_EXP${i}`, createdAt: new Date(Date.now() - i * 1000) } as any);
  // user 2 posted 200 times recently; users 3..5 have exactly one older post each
  for (let k = 0; k < 200; k++) await col("mini_posts").insertOne({ _id: `busy${k}`.padEnd(8, "x"), ownerId: 2, mediaId: "busy-media", createdAt: new Date(Date.now() - k * 10), likesCount: 0, commentsCount: 0 } as any);
  for (const u of [3, 4, 5]) await col("mini_posts").insertOne({ _id: `solo${u}`.padEnd(8, "x"), ownerId: u, mediaId: `media-${u}`, createdAt: new Date(Date.now() - 86_400_000 * u), likesCount: 0, commentsCount: 0 } as any);
  const r = await explore(6);
  const by = new Map(r.items.map((i: any) => [i.anonId ?? i.id, i]));
  const tile = (n: number) => r.items.find((i: any) => String(i.anonId ?? i.id) === `user_EXP${n}`);
  assert.equal(tile(2)?.mediaId, "busy-media");
  for (const u of [3, 4, 5]) assert.equal(tile(u)?.mediaId, `media-${u}`, `user ${u} keeps their own latest post`);
  assert.equal(tile(1)?.mediaId, null, "a user without posts still gets a placeholder tile");
  assert.ok(!r.items.some((i: any) => String(i.anonId ?? i.id) === "user_EXP6"), "the viewer is not listed");
  void by;
});
