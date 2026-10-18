/** Navagram (نوا گرام) Mini App backend: posts, profile-photo post, comments, follow, stories, highlights,
 *  gifts (Relic), share, explore/search, owner-approved profile changes, channel copy, admin panel. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { CHAT_REQUEST_ACCEPTED_TEXT } = await import("../../src/features/matching/search.js");
const { ensureChatRequestIndexes, createChatRequest } = await import("../../src/db/models/chatRequest.js");
const { present } = await import("../../src/services/nava/present.js");
const { cleanupStories } = await import("../../src/services/nava/stories.js");
const { setPostsChannel, setPostsChannelEnabled, getMiniSettings } = await import("../../src/services/nava/settings.js");
const { scoreMatch, normalizeQuery } = await import("../../src/services/nava/search.js");

/* ---- everything the Mini App backend sends through its own Api instance is recorded ---- */
const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }, { file_id: "BIG" }] };
  else if (method === "getChatMember") result = { status: "member" };
  else if (method === "savePreparedInlineMessage") result = { id: "PREP" + api.length };
  return { ok: true, result } as any;
});
const sentApi = (method: string, chat?: number) => api.filter((c) => c.method === method && (chat === undefined || c.payload.chat_id === chat));

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const tick = () => new Promise((r) => setTimeout(r, 3)); // distinct millisecond timestamps (cursor paging is by time)
async function call(userId: number, body: any) {
  if (/_create$|_add$/.test(body.action)) await tick();
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
async function get(query: Record<string, string>) {
  let status = 200; let sent: any; const headers: Record<string, string> = {};
  const res: any = { setHeader(k: string, v: string) { headers[k] = v; }, status(c: number) { status = c; return res; }, send(b: any) { sent = b; return res; }, end() { return res; }, json() { return res; } };
  await handler({ method: "GET", query } as any, res);
  return { status, sent, headers };
}
const JPEG = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]).toString("base64");
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500, 3)]).toString("base64");

beforeEach(async () => {
  resetState();
  h.resetCalls();
  api.length = 0;
  ensureSocialIndexesOnce();
  await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", profilePhotoFileId: "P1", profilePhotoAt: new Date(Date.now() - 5000), relicBalance: 20, miniUsername: "ali", miniUsernameLower: "ali" });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", profilePhotoFileId: "P2", profilePhotoAt: new Date(Date.now() - 4000), relicBalance: 2, miniUsername: "sara", miniUsernameLower: "sara" });
  seedUser({ id: 3, anonId: "user_AAA3", nickname: "نیما" }); // no photo, no username
  seedUser({ id: 4, anonId: "user_AAA4", nickname: "بن شده", banned: true, profilePhotoFileId: "P4" });
  seedUser({ id: 900, anonId: "user_OWN0", nickname: "مالک" });
});

/* ================================================================ posts */

test("post: photo + caption, no approval, shows to others, NOTHING is sent in the bot, edit/delete by owner only", async () => {
  const r = await call(1, { action: "post_create", image: JPEG, caption: "  سلام\n\nدنیا  " });
  assert.equal(r.status, 200);
  assert.equal(r.payload.item.caption, "سلام\n\nدنیا");
  assert.match(r.payload.item.src, /^\/api\/miniapp\?m=[\w-]+&s=[0-9a-f]{24}$/);
  assert.equal(sentApi("sendPhoto").length + sentApi("sendMessage").length, 0); // post photos never appear in the bot
  assert.equal(col("image_moderation").all().length, 0); // no owner approval for posts
  const pid = r.payload.item.pid;

  const feed = await call(2, { action: "home" });
  assert.ok(feed.payload.items.some((i: any) => i.pid === pid && i.kind === "post"));
  assert.equal(JSON.stringify(feed.payload).includes("mediaId"), false);

  assert.equal((await call(2, { action: "post_edit", pid, caption: "هک" })).status, 404);
  assert.equal((await call(2, { action: "post_delete", pid })).status, 404);
  assert.equal((await call(1, { action: "post_edit", pid, caption: "نو" })).payload.caption, "نو");
  assert.equal((await call(2, { action: "post", pid })).payload.item.caption, "نو");

  await call(2, { action: "like", pid, like: true });
  await call(2, { action: "comment_add", pid, text: "عالی" });
  assert.equal(col("mini_media").all().length, 1);
  assert.equal((await call(1, { action: "post_delete", pid })).status, 200);
  assert.equal(col("mini_posts").all().length + col("mini_post_likes").all().length + col("mini_comments").all().length + col("mini_media").all().length, 0);
  assert.equal((await call(2, { action: "post", pid })).status, 404);
});

test("post: bad image / too long caption rejected; the daily cap protects the DB", async () => {
  assert.equal((await call(1, { action: "post_create", image: "data:image/jpeg;base64,AAAA" })).payload.error, "bad_image");
  assert.equal((await call(1, { action: "post_create", image: JPEG, caption: "x".repeat(1001) })).payload.error, "text_too_long");
  assert.equal((await call(1, { action: "post_create", image: PNG, caption: "" })).status, 200); // caption is optional
  assert.equal(col("mini_posts").all().length, 1);
});

test("channel copy: only when the owner switched it on, exactly ONE copy per post, removed with the post", async () => {
  await call(1, { action: "post_create", image: JPEG, caption: "الف" });
  assert.equal(sentApi("sendPhoto").length, 0); // off by default
  await setPostsChannel(-1001234, "کانال");
  await call(1, { action: "post_create", image: JPEG, caption: "ب" });
  assert.equal(sentApi("sendPhoto").length, 0); // channel set but switch still off
  await setPostsChannelEnabled(true);
  const r = await call(1, { action: "post_create", image: JPEG, caption: "پ <b>" });
  const copies = sentApi("sendPhoto", -1001234);
  assert.equal(copies.length, 1);
  assert.match(copies[0]!.payload.caption, /پ &lt;b&gt;/); // escaped
  await call(1, { action: "post_edit", pid: r.payload.item.pid, caption: "ویرایش" });
  await call(2, { action: "like", pid: r.payload.item.pid });
  assert.equal(sentApi("sendPhoto", -1001234).length, 1); // edits / likes never re-send
  await call(1, { action: "post_delete", pid: r.payload.item.pid });
  assert.equal(sentApi("deleteMessage", -1001234).length, 1);
});

test("the profile photo is the FIRST post of the page: commentable, likable, follows the photo, other posts unaffected", async () => {
  const p = await call(2, { action: "post_create", image: JPEG, caption: "p1" });
  const grid = await call(1, { action: "posts", id: "user_AAA2" });
  assert.deepEqual(grid.payload.items.map((i: any) => i.pid), [p.payload.item.pid, "pp:user_AAA2"]); // profile post is the oldest = last tile
  const profile = (await call(1, { action: "profile", id: "user_AAA2" })).payload.profile;
  assert.equal(profile.posts, 2);

  const feed = await call(1, { action: "home" });
  const pp = feed.payload.items.find((i: any) => i.pid === "pp:user_AAA2");
  assert.equal(pp.kind, "profile");
  assert.match(pp.src, /u=user_AAA2&v=/);
  const oldSrc = pp.src;

  await call(1, { action: "comment_add", pid: "pp:user_AAA2", text: "عکس قشنگیه" });
  await call(1, { action: "like", pid: "pp:user_AAA2" });
  const item = (await call(1, { action: "post", pid: "pp:user_AAA2" })).payload.item;
  assert.deepEqual([item.comments, item.likes, item.liked], [1, 1, true]);
  assert.equal((await call(1, { action: "comments", pid: "pp:user_AAA2" })).payload.items[0].text, "عکس قشنگیه");

  // the photo changes (e.g. the owner approved a new one): same post id, new picture, comments stay, other posts untouched
  const { setProfilePhoto } = await import("../../src/db/models/user.js");
  await setProfilePhoto(2, "NEWPHOTO");
  const after = (await call(1, { action: "post", pid: "pp:user_AAA2" })).payload.item;
  assert.notEqual(after.src, oldSrc);
  assert.equal(after.comments, 1);
  assert.equal((await call(1, { action: "post", pid: p.payload.item.pid })).payload.item.src, p.payload.item.src);
  assert.equal(col("users").byId(2).profilePhotoAt instanceof Date, true);
  assert.notEqual((await call(1, { action: "profile", id: "user_AAA2" })).payload.profile.av, undefined);

  // a user without a photo has no profile post
  assert.equal((await call(1, { action: "post", pid: "pp:user_AAA3" })).status, 404);
  assert.equal((await call(1, { action: "profile", id: "user_AAA3" })).payload.profile.posts, 0);
});

test("home feed: newest first across posts + profile photos, paged by time cursor, no duplicates", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) ids.push((await call(1, { action: "post_create", image: JPEG, caption: `c${i}` })).payload.item.pid);
  const page1 = (await call(2, { action: "home" })).payload;
  assert.equal(page1.items.length, 8);
  assert.equal(page1.hasMore, true);
  assert.ok(Array.isArray(page1.tray));
  const page2 = (await call(2, { action: "home", before: page1.items.at(-1).at })).payload;
  const all = [...page1.items, ...page2.items].map((i: any) => i.pid);
  assert.equal(new Set(all).size, all.length);
  assert.ok(ids.every((id) => all.includes(id)));
  assert.ok(all.includes("pp:user_AAA1") && all.includes("pp:user_AAA2"));
  assert.equal(page2.tray, undefined);
  assert.equal(all.includes("pp:user_AAA4"), false); // banned user's photo never shown
});

/* ============================================================= comments */

test("comments: owner of the page AND the commenter can delete, a third person cannot; counts stay right", async () => {
  const pid = (await call(1, { action: "post_create", image: JPEG, caption: "" })).payload.item.pid;
  const c1 = (await call(2, { action: "comment_add", pid, text: "اولی" })).payload.comment;
  const c2 = (await call(3, { action: "comment_add", pid, text: "دومی" })).payload;
  assert.equal(c2.comments, 2);
  assert.equal(c2.comment.canDelete, true);
  const list = (await call(2, { action: "comments", pid })).payload;
  assert.deepEqual(list.items.map((c: any) => [c.text, c.canDelete]), [["دومی", false], ["اولی", true]]);
  assert.equal((await call(3, { action: "comment_delete", commentId: c1.id })).payload.error, "forbidden");
  assert.equal((await call(2, { action: "comment_delete", commentId: c1.id })).payload.comments, 1); // commenter
  assert.equal((await call(1, { action: "comment_delete", commentId: c2.comment.id })).payload.comments, 0); // page owner
  assert.equal((await call(1, { action: "comment_delete", commentId: c2.comment.id })).status, 404);
  assert.equal(col("mini_posts").byId(pid).commentsCount, 0);
  assert.equal((await call(2, { action: "comment_add", pid, text: "   " })).payload.error, "bad_text");
  assert.equal((await call(2, { action: "comment_add", pid, text: "x".repeat(501) })).payload.error, "text_too_long");
});

test("comments: rate limit (10/min) and blocked users do not see each other's content", async () => {
  const pid = (await call(1, { action: "post_create", image: JPEG })).payload.item.pid;
  for (let i = 0; i < 10; i++) assert.equal((await call(2, { action: "comment_add", pid, text: `n${i}` })).status, 200);
  assert.equal((await call(2, { action: "comment_add", pid, text: "یازدهم" })).status, 429);
  await col("blocks").seed({ _id: "1:2", blockerId: 1, blockedId: 2, createdAt: new Date() });
  assert.equal((await call(2, { action: "post", pid })).status, 404);
  assert.equal((await call(2, { action: "profile", id: "user_AAA1" })).status, 404);
  assert.equal((await call(1, { action: "comments", pid })).payload.items.length, 0); // 2's comments hidden from 1
  assert.equal((await call(2, { action: "explore" })).payload.items.some((i: any) => i.id === "user_AAA1"), false);
});

/* =============================================================== follow */

test("follow: idempotent, numbers on the profile, lists, never yourself", async () => {
  assert.deepEqual((await call(1, { action: "follow", id: "user_AAA2" })).payload, { following: true, followers: 1 });
  assert.deepEqual((await call(1, { action: "follow", id: "user_AAA2" })).payload, { following: true, followers: 1 });
  await call(3, { action: "follow", id: "user_AAA2" });
  await call(2, { action: "follow", id: "user_AAA1" });
  const p = (await call(1, { action: "profile", id: "user_AAA2" })).payload.profile;
  assert.deepEqual([p.followers, p.following, p.iFollow, p.followsMe, p.isMe], [2, 1, true, true, false]);
  const fl = (await call(1, { action: "follows", id: "user_AAA2", type: "followers" })).payload;
  assert.deepEqual(fl.items.map((x: any) => x.id).sort(), ["user_AAA1", "user_AAA3"]);
  assert.equal(fl.items.find((x: any) => x.id === "user_AAA1").isMe, true);
  assert.equal((await call(1, { action: "follows", id: "user_AAA2", type: "nonsense" })).status, 404);
  assert.deepEqual((await call(1, { action: "follow", id: "user_AAA2", follow: false })).payload, { following: false, followers: 1 });
  assert.deepEqual((await call(1, { action: "follow", id: "user_AAA2", follow: false })).payload, { following: false, followers: 1 });
  assert.equal((await call(1, { action: "follow", id: "user_AAA1" })).payload.error, "self");
  assert.equal((await call(1, { action: "follow", id: "user_AAA4" })).status, 404); // banned
});

/* ============================================================== stories */

test("stories: 24h life, tray order + seen ring, viewers only for the owner, delete", async () => {
  const s1 = (await call(2, { action: "story_create", image: JPEG, caption: "امروز" })).payload.story;
  assert.equal(sentApi("sendPhoto").length, 0); // stories are never sent in the bot either
  const tray = (await call(1, { action: "home" })).payload.tray;
  assert.deepEqual(tray.map((t: any) => [t.id, t.story]), [["user_AAA2", 2]]);
  assert.equal(JSON.stringify(tray).includes("pv"), false);
  const st = (await call(1, { action: "stories", id: "user_AAA2" })).payload;
  assert.equal(st.stories.length, 1);
  assert.equal(st.stories[0].views, undefined); // viewer count is for the owner only
  await call(1, { action: "story_view", storyId: s1.id });
  await call(1, { action: "story_view", storyId: s1.id });
  assert.equal((await call(1, { action: "home" })).payload.tray[0].story, 1); // seen -> grey ring
  assert.equal((await call(1, { action: "story_viewers", storyId: s1.id })).status, 404);
  const mine = (await call(2, { action: "story_viewers", storyId: s1.id })).payload;
  assert.deepEqual([mine.count, mine.viewers[0].id], [1, "user_AAA1"]);
  assert.equal((await call(2, { action: "stories", id: "user_AAA2" })).payload.stories[0].views, 1);

  // after 24 h it disappears from the tray / viewer but stays in the owner's archive
  await col("mini_stories").updateOne({ _id: s1.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(1, { action: "home" })).payload.tray.length, 0);
  assert.equal((await call(1, { action: "stories", id: "user_AAA2" })).payload.stories.length, 0);
  assert.equal((await call(2, { action: "story_archive" })).payload.items.length, 1);

  const s2 = (await call(2, { action: "story_create", image: PNG })).payload.story;
  assert.equal((await call(1, { action: "story_delete", storyId: s2.id })).status, 404);
  assert.equal((await call(2, { action: "story_delete", storyId: s2.id })).status, 200);
  assert.equal(col("mini_stories").all().length, 1);
});

test("highlights: create from stories, edit NAME and COVER, play after the stories expired, cleanup keeps highlighted ones", async () => {
  const a = (await call(2, { action: "story_create", image: JPEG })).payload.story;
  const b = (await call(2, { action: "story_create", image: PNG })).payload.story;
  const old = (await call(2, { action: "story_create", image: PNG })).payload.story;
  assert.equal((await call(2, { action: "highlight_create", title: "", storyIds: [a.id] })).status, 400);
  assert.equal((await call(2, { action: "highlight_create", title: "سفر", storyIds: ["nope123456"] })).status, 404);
  assert.equal((await call(1, { action: "highlight_create", title: "دزدی", storyIds: [a.id] })).status, 404); // someone else's story
  const hl = (await call(2, { action: "highlight_create", title: "سفر", storyIds: [a.id, b.id], coverStoryId: b.id })).payload.highlight;
  assert.deepEqual([hl.title, hl.count], ["سفر", 2]);
  assert.match(hl.cover, /^\/api\/miniapp\?m=/);

  const renamed = (await call(2, { action: "highlight_edit", hid: hl.id, title: "شمال" })).payload.highlight;
  assert.equal(renamed.title, "شمال");
  const mediaBefore = col("mini_media").all().length;
  const withCover = (await call(2, { action: "highlight_edit", hid: hl.id, coverImage: JPEG })).payload.highlight;
  assert.notEqual(withCover.cover, hl.cover);
  assert.equal(col("mini_media").all().length, mediaBefore + 1);
  await call(2, { action: "highlight_edit", hid: hl.id, coverImage: JPEG }); // replacing the cover must not leak the old one
  assert.equal(col("mini_media").all().length, mediaBefore + 1);
  assert.equal((await call(1, { action: "highlight_edit", hid: hl.id, title: "هک" })).status, 404);

  // everything expires + the 30 day archive passes
  const longAgo = new Date(Date.now() - 40 * 86_400_000);
  for (const s of [a, b, old]) await col("mini_stories").updateOne({ _id: s.id }, { $set: { createdAt: longAgo, expiresAt: new Date(longAgo.getTime() + 86_400_000) } });
  assert.equal(await cleanupStories(), 1); // only the story that is in no highlight
  const played = (await call(1, { action: "highlight", hid: hl.id })).payload;
  assert.equal(played.title, "شمال");
  assert.equal(played.stories.length, 2);
  const prof = (await call(1, { action: "profile", id: "user_AAA2" })).payload.profile;
  assert.deepEqual(prof.highlights.map((x: any) => [x.title, x.count]), [["شمال", 2]]);

  await call(2, { action: "story_delete", storyId: a.id });
  assert.equal((await call(1, { action: "highlight", hid: hl.id })).payload.stories.length, 1);
  await call(2, { action: "story_delete", storyId: b.id });
  assert.equal((await call(1, { action: "highlight", hid: hl.id })).status, 404); // an emptied highlight disappears
  assert.equal((await call(2, { action: "highlight_delete", hid: hl.id })).status, 404);
});

/* ================================================================ gifts */

test("gifts: price in Relic taken from the giver, error when the balance is not enough, shows giver name, idempotent", async () => {
  const cat = (await call(2, { action: "gift_catalog" })).payload;
  assert.equal(cat.balance, 2);
  assert.equal(cat.items.find((g: any) => g.id === "rose").price, 2);

  const poor = await call(2, { action: "gift_send", id: "user_AAA1", giftId: "cup", clientId: "client-aaa-1" }); // 15 > 2
  assert.equal(poor.status, 402);
  assert.equal(poor.payload.error, "insufficient");
  assert.equal(col("users").byId(2).relicBalance, 2);
  assert.equal(col("mini_gifts").all().length, 0);

  const ok = await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cup", message: "تولدت مبارک", clientId: "client-bbb-1" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.payload.status, ok.payload.balance], ["sent", 5]);
  assert.equal(col("users").byId(1).relicBalance, 5);
  assert.equal(col("users").byId(2).relicBalance, 2); // the receiver is not charged (nor paid): Relic is burned
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "GIFT_SENT").length, 1);

  // tapping twice / retried request: no second charge
  const again = await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cup", message: "تولدت مبارک", clientId: "client-bbb-1" });
  assert.deepEqual([again.payload.status, again.payload.balance], ["duplicate", 5]);
  assert.equal(col("mini_gifts").all().length, 1);

  const list = (await call(3, { action: "gifts", id: "user_AAA2" })).payload;
  assert.equal(list.total, 1);
  assert.deepEqual([list.items[0].giftId, list.items[0].message, list.items[0].from.id, list.items[0].from.name], ["cup", "تولدت مبارک", "user_AAA1", "علی"]);
  assert.equal((await call(3, { action: "profile", id: "user_AAA2" })).payload.profile.gifts, 1);
  assert.ok(sentApi("sendMessage", 2).some((m) => /@ali/.test(m.payload.text) && /جام/.test(m.payload.text))); // receiver is told who sent it

  assert.equal((await call(1, { action: "gift_send", id: "user_AAA1", giftId: "cup", clientId: "client-self-1" })).payload.error, "self");
  assert.equal((await call(1, { action: "gift_send", id: "user_AAA2", giftId: "nope", clientId: "client-ccc-1" })).payload.error, "bad_gift");
  assert.equal((await call(1, { action: "gift_send", id: "user_AAA2", giftId: "heart", clientId: "x" })).payload.error, "bad_input");
});

test("gifts: ten parallel taps with the same id charge once; two different gifts racing for the last Relic -> one wins", async () => {
  const r = await Promise.all(Array.from({ length: 10 }, () => call(1, { action: "gift_send", id: "user_AAA2", giftId: "rocket", clientId: "same-tap-001" })));
  assert.equal(r.filter((x) => x.payload.status === "sent").length, 1);
  assert.equal(col("users").byId(1).relicBalance, 10);
  assert.equal(col("mini_gifts").all().length, 1);

  const race = await Promise.all([
    call(2, { action: "gift_send", id: "user_AAA1", giftId: "rose", clientId: "race-aaaa-1" }),
    call(2, { action: "gift_send", id: "user_AAA3", giftId: "rose", clientId: "race-bbbb-2" }),
  ]); // balance 2, each costs 2
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 402]);
  assert.equal(col("users").byId(2).relicBalance, 0);
});

test("gifts: the owner can change prices / switch a gift off from the settings (MongoDB, not env)", async () => {
  const { setGiftPrice, setGiftEnabled } = await import("../../src/services/nava/settings.js");
  await setGiftPrice("heart", 7);
  await setGiftEnabled("rose", false);
  const cat = (await call(1, { action: "gift_catalog" })).payload.items;
  assert.equal(cat.find((g: any) => g.id === "heart").price, 7);
  assert.equal(cat.some((g: any) => g.id === "rose"), false);
  assert.equal((await call(1, { action: "gift_send", id: "user_AAA2", giftId: "rose", clientId: "disabled-001" })).payload.error, "bad_gift");
  assert.equal((await call(1, { action: "gift_send", id: "user_AAA2", giftId: "heart", clientId: "price-00001" })).payload.balance, 13);
});

/* ================================================================ share */

test("share: the REAL photo + caption is prepared for Telegram (not a link), with an 'open' button", async () => {
  const p = (await call(1, { action: "post_create", image: JPEG, caption: "کپشن من" })).payload.item;
  const r = await call(2, { action: "share", pid: p.pid });
  assert.equal(r.status, 200);
  const prep = sentApi("savePreparedInlineMessage").at(-1)!.payload;
  assert.equal(prep.user_id, 2);
  assert.equal(prep.result.type, "photo");
  assert.match(prep.result.photo_url, /^https:\/\/nava\.example\.com\/api\/miniapp\?m=[\w-]+&s=[0-9a-f]{24}$/);
  assert.match(prep.result.caption, /کپشن من/);
  assert.match(prep.result.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/NavaTestBot\?startapp=p_/);
  // the signed URL really serves the photo bytes; a forged one does not
  const u = new URL(prep.result.photo_url);
  const ok = await get({ m: u.searchParams.get("m")!, s: u.searchParams.get("s")! });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Content-Type"], "image/jpeg");
  assert.equal((await get({ m: u.searchParams.get("m")!, s: "0".repeat(24) })).status, 403);
  // profile post -> uses the stored Telegram file id; a profile -> photo + bio
  await call(2, { action: "share", pid: "pp:user_AAA1" });
  assert.equal(sentApi("savePreparedInlineMessage").at(-1)!.payload.result.photo_file_id, "P1");
  await call(1, { action: "set_bio", bio: "بیو من" });
  await call(2, { action: "share", uid: "user_AAA1" });
  assert.match(sentApi("savePreparedInlineMessage").at(-1)!.payload.result.caption, /بیو من/);
  await call(2, { action: "share", uid: "user_AAA3" }); // no photo -> article
  assert.equal(sentApi("savePreparedInlineMessage").at(-1)!.payload.result.type, "article");
  assert.equal((await call(2, { action: "share", pid: "zzzzzzzz" })).status, 404);
});

/* ======================================================== explore/search */

test("explore: ALL users incl. those without photo/posts (no 'empty explore'); paged; no telegram ids", async () => {
  for (let i = 10; i < 40; i++) seedUser({ id: i, anonId: `user_B${i}`, nickname: "تست" });
  const first = (await call(1, { action: "explore" })).payload;
  assert.equal(first.items.length, 24);
  assert.equal(first.hasMore, true);
  const second = (await call(1, { action: "explore", offset: first.next })).payload;
  const ids = [...first.items, ...second.items].map((i: any) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 4 + 30 - 1 + 0); // users 2,3,900 + 30 new  = 33 (me excluded, banned excluded)
  assert.equal(ids.includes("user_AAA1"), false);
  assert.equal(ids.includes("user_AAA4"), false);
  assert.equal(JSON.stringify([first, second]).includes('"_id"'), false);
});

test("explore tile = the user's latest post, else the profile photo, else a placeholder", async () => {
  const p = (await call(2, { action: "post_create", image: JPEG })).payload.item;
  const items = (await call(1, { action: "explore" })).payload.items;
  assert.equal(items.find((i: any) => i.id === "user_AAA2").src, p.src);
  assert.equal(items.find((i: any) => i.id === "user_AAA3").src, null);
  assert.equal(items.find((i: any) => i.id === "user_AAA3").tileSrc, null);
});

test("search: precise ranking (exact > prefix > contains), Persian letter variants, Nava ID, recents", async () => {
  seedUser({ id: 20, anonId: "user_C20", nickname: "علیرضا", miniUsername: "alireza", miniUsernameLower: "alireza" });
  seedUser({ id: 21, anonId: "user_C21", nickname: "مهدی", miniUsername: "the.ali.fan", miniUsernameLower: "the.ali.fan" });
  seedUser({ id: 22, anonId: "user_C22", nickname: "کیان", miniUsername: "kian", miniUsernameLower: "kian" });
  const s = async (q: string) => (await call(2, { action: "search", q })).payload.items.map((i: any) => i.username ?? i.name);
  assert.deepEqual(await s("ali"), ["ali", "alireza", "the.ali.fan"]); // exact, prefix, contains
  assert.deepEqual(await s("@ALI"), ["ali", "alireza", "the.ali.fan"]);
  assert.deepEqual(await s("علي"), ["ali", "alireza"]); // Arabic ي -> ی ; nickname علی / علیرضا
  assert.deepEqual(await s("کيان"), ["kian"]); // ي in the query, nickname کیان
  assert.deepEqual(await s("user_C22"), ["kian"]); // Nava ID
  assert.deepEqual(await s("zzzz"), []);
  assert.deepEqual(await s("   "), []);
  assert.equal(await s("sara").then((x) => x.includes("sara")), false); // never myself

  assert.deepEqual((await call(2, { action: "search", q: "" })).payload, { items: [], recent: true });
  await call(2, { action: "recent_add", id: "user_C22" });
  await call(2, { action: "recent_add", id: "user_AAA1" });
  await call(2, { action: "recent_add", id: "user_C22" });
  assert.deepEqual((await call(2, { action: "search", q: "" })).payload.items.map((i: any) => i.id), ["user_C22", "user_AAA1"]);
  await call(2, { action: "recent_remove", id: "user_C22" });
  assert.deepEqual((await call(2, { action: "search", q: "" })).payload.items.map((i: any) => i.id), ["user_AAA1"]);
  await call(2, { action: "recent_clear" });
  assert.equal((await call(2, { action: "search", q: "" })).payload.items.length, 0);
  assert.equal((await call(2, { action: "recent_add", id: "user_AAA4" })).status, 404); // banned

  assert.equal(normalizeQuery("  @Ali  "), "ali");
  assert.equal(normalizeQuery("۱۲۳"), "123");
  assert.ok(scoreMatch("ali", { miniUsername: "ali" }) > scoreMatch("ali", { miniUsername: "alina" }));
});

/* ================================================== profile / bot sync */

test("name & age changes asked in the Mini App follow the bot's rule: owner approval, then applied; bio is direct (≤300)", async () => {
  const bad = await call(1, { action: "request_change", field: "nickname", value: "Ali123" });
  assert.equal(bad.payload.error, "bad_name");
  assert.equal((await call(1, { action: "request_change", field: "age", value: 8 })).payload.error, "bad_age");
  assert.equal((await call(1, { action: "request_change", field: "age", value: 100 })).payload.error, "bad_age");
  assert.equal((await call(1, { action: "request_change", field: "nickname", value: "علی" })).payload.error, "same_value");
  assert.equal((await call(1, { action: "request_change", field: "phone", value: "1" })).status, 400);

  const ok = await call(1, { action: "request_change", field: "nickname", value: "علیرضا" });
  assert.equal(ok.payload.status, "pending");
  assert.equal(col("users").byId(1).nickname, "علی"); // NOT applied yet
  const toOwner = sentApi("sendMessage", 900).at(-1)!;
  assert.match(toOwner.payload.text, /علیرضا/);
  const approveData = toOwner.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
  assert.match(approveData, /^admin:editreq:approve:/);
  assert.equal((await call(1, { action: "request_change", field: "nickname", value: "رضا" })).status, 409); // one pending request per field
  assert.equal((await call(1, { action: "me" })).payload.me.pendingName, "علیرضا");

  await h.callback(900, approveData);
  assert.equal(col("users").byId(1).nickname, "علیرضا");
  assert.equal((await call(2, { action: "profile", id: "user_AAA1" })).payload.profile.name, "علیرضا");
  assert.equal((await call(1, { action: "me" })).payload.me.pendingName, null);

  assert.equal((await call(1, { action: "request_change", field: "age", value: 30 })).payload.status, "pending");
  assert.equal(col("users").byId(1).age, 25);
  await h.callback(900, sentApi("sendMessage", 900).at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(col("users").byId(1).age, 30);

  assert.equal((await call(1, { action: "set_bio", bio: "ب".repeat(300) })).status, 200);
  assert.equal((await call(1, { action: "set_bio", bio: "ب".repeat(301) })).status, 400);
  assert.equal(col("users").byId(1).bio.length, 300);
});

test("profile page: the Instagram numbers + chat state; own profile carries Relic / pending flags", async () => {
  await call(2, { action: "post_create", image: JPEG });
  await call(1, { action: "follow", id: "user_AAA2" });
  const p = (await call(1, { action: "profile", id: "user_AAA2" })).payload.profile;
  assert.deepEqual([p.id, p.username, p.name, p.posts, p.followers, p.following, p.chat], ["user_AAA2", "sara", "سارا", 2, 1, 0, "none"]);
  assert.equal(p.relic, undefined); // other people's Relic is private
  assert.equal(JSON.stringify(p).includes('"_id"'), false);
  const me = (await call(2, { action: "me" })).payload.me;
  assert.deepEqual([me.isMe, me.relic, me.followers, me.chat], [true, 2, 1, "me"]);
  await col("users").updateOne({ _id: 2 }, { $set: { activeChatSessionId: "S1" } });
  assert.equal((await call(1, { action: "profile", id: "user_AAA2" })).payload.profile.chat, "busy");
});

test("avatars / photos are signed capability URLs; telegram file ids never reach the client", async () => {
  const r = await call(1, { action: "whoami" });
  assert.equal(r.payload.role, "user");
  assert.match(r.payload.me.av, /^\/api\/miniapp\?u=user_AAA1&v=[0-9a-f]{8}&s=[0-9a-f]{24}$/);
  assert.equal(JSON.stringify(r.payload).includes("P1"), false);
  const u = new URL("https://x" + r.payload.me.av);
  assert.equal((await get({ u: "user_AAA1", s: "f".repeat(24) })).status, 403);
  assert.equal((await get({ u: "user_AAA3", s: u.searchParams.get("s")! })).status, 403); // signature is per user
  assert.equal((await get({})).status, 400);
  const p = present({ id: "user_X", pv: "abcd1234", nested: [{ mediaId: "m1", coverMediaId: null }] }) as any;
  assert.match(p.av, /u=user_X&v=abcd1234/);
  assert.match(p.nested[0].src, /m=m1/);
  assert.equal(p.nested[0].cover, null);
});

/* ===================================================== bot-side fixes */

test("accepted chat request: both people get «chat accepted, you can talk now» — NOT «I found you a partner»", async () => {
  const req = await createChatRequest(1, 2);
  assert.equal(req.status, "created");
  const token = (req as any).request._id;
  await h.callback(2, `crq:a:${token}`);
  const texts = (uid: number) => h.of("sendMessage", uid).map((c) => String(c.payload.text));
  assert.ok(texts(1).includes(CHAT_REQUEST_ACCEPTED_TEXT), "requester told");
  assert.ok(texts(2).includes(CHAT_REQUEST_ACCEPTED_TEXT), "acceptor told");
  assert.equal([...texts(1), ...texts(2)].some((t) => t.includes("پیدا کردم")), false);
  assert.match(CHAT_REQUEST_ACCEPTED_TEXT, /قبول شد/);
  assert.match(CHAT_REQUEST_ACCEPTED_TEXT, /صحبت/);
});

test("chat request from the Mini App works for a target WITHOUT a profile photo, and says so for a busy one", async () => {
  const r = await call(1, { action: "request", id: "user_AAA3" });
  assert.equal(r.payload.status, "sent");
  assert.equal((await call(1, { action: "profile", id: "user_AAA3" })).payload.profile.chat, "requested");
  assert.equal((await call(1, { action: "request", id: "user_AAA3" })).payload.status, "already_pending");
  assert.equal((await call(1, { action: "request", id: "user_AAA4" })).payload.status, "unavailable"); // banned
});

/* ===================================================== admin panel */

test("admin panel «نوا گرام»: owner toggles channel copy, sets the channel, edits gift price; a normal user cannot", async () => {
  await h.callback(1, "admin:ng:tch");
  assert.equal((await getMiniSettings()).postsChannelEnabled, false); // ignored for non-admins

  await h.callback(900, "admin:ng:tch");
  assert.equal((await getMiniSettings()).postsChannelEnabled, true);
  await h.callback(900, "admin:ng:tch");
  assert.equal((await getMiniSettings()).postsChannelEnabled, false);

  await h.callback(900, "admin:ng:sch");
  await h.text(900, "not a channel");
  assert.equal((await getMiniSettings()).postsChannelId, null);
  await h.text(900, "-1009876543210");
  const s = await getMiniSettings();
  assert.deepEqual([s.postsChannelId, s.postsChannelTitle], [-1009876543210, "Test Channel"]);

  await h.callback(900, "admin:ng:gp:cake");
  await h.text(900, "abc");
  assert.equal((await getMiniSettings()).giftPrices.cake, undefined);
  await h.text(900, "12");
  assert.equal((await getMiniSettings()).giftPrices.cake, 12);
  await h.callback(900, "admin:ng:gt:cake");
  assert.equal((await getMiniSettings()).giftsDisabled.cake, true);

  await h.callback(900, "admin:ng:cch");
  const cleared = await getMiniSettings();
  assert.deepEqual([cleared.postsChannelId, cleared.postsChannelEnabled], [null, false]);
});

test("admin keyboard: «📸 نوا گرام» is ONE direct category; its button opens the Navagram screen (no nested settings)", async () => {
  await h.text(900, "/start");
  await h.text(900, "📸 نوا گرام");
  const kb = JSON.stringify(h.last("sendMessage", 900)?.payload.reply_markup);
  assert.match(kb, /هدیه‌ها و قیمت‌ها/);
  assert.match(kb, /ساخت|هدیه‌ی جدید/);
  await h.text(900, "📸 کانال و تنظیمات نوا گرام");
  assert.match(JSON.stringify(h.last("sendMessage", 900)?.payload.reply_markup), /admin:ng:tch/);
});

/* ===================================================== post options / catalog / deep links */

test("post options: ratio, comments off (blocks new comments, owner can switch back), hide-likes (others get no number, owner still sees it)", async () => {
  const r = await call(1, { action: "post_create", image: JPEG, caption: "x", ratio: "1:1", noComments: true, hideLikes: true });
  assert.equal(r.status, 200);
  const it = r.payload.item;
  assert.equal(it.ar, 1);
  assert.equal(it.noComments, true);
  assert.equal(it.hideLikes, true);
  // an unknown ratio falls back to 4:5
  const d = await call(1, { action: "post_create", image: JPEG, ratio: "9:99" });
  assert.equal(d.payload.item.ar, 0.8);

  // comments are closed for everyone
  assert.equal((await call(2, { action: "comment_add", pid: it.pid, text: "سلام" })).payload.error, "comments_off");
  assert.equal((await call(1, { action: "comment_add", pid: it.pid, text: "من" })).payload.error, "comments_off");

  // likes: the number is hidden for others, visible for the owner
  await call(2, { action: "like", pid: it.pid, like: true });
  assert.equal((await call(2, { action: "post", pid: it.pid })).payload.item.likes, 0);
  assert.equal((await call(2, { action: "post", pid: it.pid })).payload.item.liked, true);
  assert.equal((await call(1, { action: "post", pid: it.pid })).payload.item.likes, 1);

  // only the owner switches the options; the caption stays untouched
  assert.equal((await call(2, { action: "post_edit", pid: it.pid, noComments: false })).status, 404);
  const e = await call(1, { action: "post_edit", pid: it.pid, noComments: false, hideLikes: false });
  assert.deepEqual(e.payload, { caption: "x", noComments: false, hideLikes: false });
  assert.equal((await call(2, { action: "comment_add", pid: it.pid, text: "حالا آره" })).status, 200);
  assert.equal((await call(2, { action: "post", pid: it.pid })).payload.item.likes, 1);
});

test("gift catalog: all ten gifts for the profile page, only active ones to send, balance included", async () => {
  const c = await call(1, { action: "gift_catalog" });
  assert.equal(c.status, 200);
  assert.equal(c.payload.items.length, 10);
  assert.equal(c.payload.all.length, 10);
  assert.equal(c.payload.balance, 20);
  assert.ok(c.payload.items.every((g: any) => g.emoji && g.price > 0 && g.c1 && g.c2));
});

test("whoami: tells the Mini App the bot username (for deep links) and never leaks ids", async () => {
  const w = await call(1, { action: "whoami" });
  assert.equal(w.status, 200);
  assert.equal(w.payload.role, "user");
  assert.equal(w.payload.bot, "NavaTestBot");
  assert.equal(w.payload.me.id, "user_AAA1");
  assert.equal(JSON.stringify(w.payload).includes("profilePhotoFileId"), false);
});

test("share deep links: post -> p_, profile photo -> q_, profile -> u_", async () => {
  const p = (await call(1, { action: "post_create", image: JPEG, caption: "k" })).payload.item;
  const url = () => sentApi("savePreparedInlineMessage").at(-1)!.payload.result.reply_markup.inline_keyboard[0][0].url as string;
  await call(2, { action: "share", pid: p.pid });
  assert.equal(url(), `https://t.me/NavaTestBot?startapp=p_${p.pid}`);
  await call(2, { action: "share", pid: "pp:user_AAA1" });
  assert.equal(url(), "https://t.me/NavaTestBot?startapp=q_user_AAA1");
  await call(2, { action: "share", uid: "user_AAA1" });
  assert.equal(url(), "https://t.me/NavaTestBot?startapp=u_user_AAA1");
});
