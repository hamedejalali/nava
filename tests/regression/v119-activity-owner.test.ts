/** v1.19.0 — activity (heart) notifications + comment replies/likes, official «Nava» account (gold coin, auto-follow, @Nava),
 *  short usernames, picture gifts, gifts to default members, one-message member creation. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { ensureChatRequestIndexes } = await import("../../src/db/models/chatRequest.js");
const { setShortUsernameIds } = await import("../../src/db/models/settings.js");
const { createSeed } = await import("../../src/db/models/seeds.js");
const { addCustomGift } = await import("../../src/services/nava/giftDefs.js");
const { giftCatalog } = await import("../../src/services/nava/gifts.js");
const { parseQuickSeed } = await import("../../src/features/admin/seedsAdmin.js");

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  return { ok: true, result: /^send/.test(method) ? { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" } } : true } as any;
});

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}

beforeEach(async () => {
  resetState();
  h.resetCalls();
  api.length = 0;
  ensureSocialIndexesOnce();
  await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: OWNER_ID, anonId: "user_OWNR", nickname: "حامد", relicBalance: 0, relicInitialized: true });
  seedUser({ id: ADMIN_ID, anonId: "user_ADMN", nickname: "ادمین", relicBalance: 0, relicInitialized: true });
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", relicBalance: 500, relicInitialized: true });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", relicBalance: 500, relicInitialized: true });
  col("mini_posts").insertOne({ _id: "post000001", ownerId: 2, mediaId: "m1", caption: "x", createdAt: new Date(), likesCount: 0, commentsCount: 0 } as any);
});
const notifs = (userId?: number) => col("mini_notifs").all().filter((n: any) => userId === undefined || n.userId === userId);

/* ----------------------------------------------------- official account */
test("O1. everybody follows the official Nava account once (unfollow is respected); no notification is created", async () => {
  await call(1, { action: "whoami" });
  assert.ok(col("mini_follows").byId(`1:${OWNER_ID}`));
  assert.equal(notifs(OWNER_ID).length, 0);
  await call(1, { action: "follow", id: "user_OWNR", follow: false });
  await call(1, { action: "whoami" });
  assert.equal(col("mini_follows").byId(`1:${OWNER_ID}`), undefined, "not forced again");
});

test("O2. the owner's account shows the blue tick + gold coin, wherever it appears", async () => {
  const p = (await call(2, { action: "profile", id: "user_OWNR" })).payload.profile;
  assert.equal(p.verified, true);
  assert.equal(p.gold, true);
  const other = (await call(1, { action: "profile", id: "user_AAA2" })).payload.profile;
  assert.equal(other.gold, undefined);
});

test("U1. usernames need 5+ characters; the owner and listed ids may use any length; «Nava» belongs to the owner only", async () => {
  assert.equal((await call(1, { action: "set_username", username: "abcd" })).payload.error, "too_short");
  assert.equal((await call(1, { action: "set_username", username: "abcde" })).status, 200);
  await setShortUsernameIds([2]);
  assert.equal((await call(2, { action: "set_username", username: "a" })).status, 200);
  assert.equal((await call(2, { action: "check_username", username: "ab12" })).payload.available, true);
  assert.equal((await call(1, { action: "check_username", username: "ab12" })).payload.reason, "too_short");
  // an admin cannot grab the official name either
  assert.equal((await call(ADMIN_ID, { action: "set_username", username: "Nava" })).payload.error, "reserved");
  assert.equal((await call(1, { action: "set_username", username: "Nava" })).payload.error, "reserved");
  const r = await call(OWNER_ID, { action: "set_username", username: "Nava" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.username, "Nava");
  // removing an id from the list takes the privilege away for NEW names
  await setShortUsernameIds([]);
  assert.equal((await call(2, { action: "check_username", username: "xy12" })).payload.reason, "too_short");
});

/* ----------------------------------------------------------- activity */
test("A1. follow → notification; unfollow removes it; repeated follow never duplicates", async () => {
  await call(1, { action: "follow", id: "user_AAA2", follow: true });
  await call(1, { action: "follow", id: "user_AAA2", follow: true });
  assert.equal(notifs(2).filter((n: any) => n.type === "follow").length, 1);
  const list = (await call(2, { action: "notifs" })).payload;
  assert.equal(list.items[0].type, "follow");
  assert.equal(list.items[0].actor.id, "user_AAA1");
  assert.equal(list.items[0].iFollow, false);
  await call(1, { action: "follow", id: "user_AAA2", follow: false });
  assert.equal(notifs(2).length, 0);
});

test("A2. post like → one notification with the post's picture; unlike removes it; liking your own post tells nobody", async () => {
  await call(1, { action: "like", pid: "post000001", like: true });
  await call(1, { action: "like", pid: "post000001", like: true });
  assert.equal(notifs(2).length, 1);
  const it = (await call(2, { action: "notifs" })).payload.items[0];
  assert.equal(it.type, "like_post");
  assert.match(it.src, /^\/api\/miniapp\?m=/);
  await call(1, { action: "like", pid: "post000001", like: false });
  assert.equal(notifs(2).length, 0);
  await call(2, { action: "like", pid: "post000001", like: true });
  assert.equal(notifs().length, 0);
});

test("A3. comment → owner is told; reply → the commenter is told (not twice); comment like → author is told; deleting cleans everything", async () => {
  const c = (await call(1, { action: "comment_add", pid: "post000001", text: "عالی بود" })).payload.comment;
  assert.equal(notifs(2).filter((n: any) => n.type === "comment").length, 1);
  assert.equal(c.likes, 0);
  const rep = (await call(2, { action: "comment_add", pid: "post000001", text: "ممنون", replyTo: c.id })).payload.comment;
  assert.deepEqual(rep.replyTo, { id: c.id, name: "علی" });
  assert.equal(notifs(1).filter((n: any) => n.type === "reply").length, 1);
  assert.equal(notifs(2).filter((n: any) => n.type === "comment").length, 1, "owner answering is not told about his own reply");
  // a third person replying to the commenter: commenter gets a reply, the post owner a comment
  seedUser({ id: 3, anonId: "user_AAA3", nickname: "نیما", relicBalance: 1, relicInitialized: true });
  await call(3, { action: "comment_add", pid: "post000001", text: "موافقم", replyTo: c.id });
  assert.equal(notifs(1).filter((n: any) => n.type === "reply").length, 2);
  assert.equal(notifs(2).filter((n: any) => n.type === "comment").length, 2);
  // like the comment, twice → one notification, counter 1
  const l1 = await call(2, { action: "comment_like", commentId: c.id, like: true });
  const l2 = await call(2, { action: "comment_like", commentId: c.id, like: true });
  assert.deepEqual([l1.payload, l2.payload], [{ liked: true, likes: 1 }, { liked: true, likes: 1 }]);
  assert.equal(notifs(1).filter((n: any) => n.type === "like_comment").length, 1);
  const shown = (await call(1, { action: "comments", pid: "post000001" })).payload.items.find((x: any) => x.id === c.id);
  assert.deepEqual([shown.likes, shown.liked], [1, false]);
  const asLiker = (await call(2, { action: "comments", pid: "post000001" })).payload.items.find((x: any) => x.id === c.id);
  assert.equal(asLiker.liked, true);
  // the author can reply from the notification list: the row carries the comment id
  const row = (await call(1, { action: "notifs" })).payload.items.find((x: any) => x.type === "reply");
  assert.ok(row.commentId && row.pid === "post000001");
  // delete the comment: its notifications and likes vanish
  await call(1, { action: "comment_delete", commentId: c.id });
  assert.equal(notifs().filter((n: any) => n.commentId === c.id).length, 0);
  assert.equal(col("mini_comment_likes").all().length, 0);
});

test("A4. pulse: unread counts by group, then «seen» zeroes them; coins and request count ride along", async () => {
  await call(1, { action: "follow", id: "user_AAA2", follow: true });
  await call(1, { action: "like", pid: "post000001", like: true });
  await call(1, { action: "comment_add", pid: "post000001", text: "سلام" });
  let p = (await call(2, { action: "pulse" })).payload;
  assert.deepEqual(p.unread, { total: 3, likes: 1, follows: 1, comments: 1 });
  assert.equal(p.relic, 500);
  col("users").updateOne({ _id: 2 }, { $set: { relicBalance: 321 } });
  assert.equal((await call(2, { action: "pulse" })).payload.relic, 321);
  await call(2, { action: "notifs_seen" });
  p = (await call(2, { action: "pulse" })).payload;
  assert.equal(p.unread.total, 0);
});

test("A5. private page: a follow REQUEST notifies; approving removes it, tells the requester and creates «follows you»", async () => {
  await call(2, { action: "set_private", on: true });
  const r = await call(1, { action: "follow", id: "user_AAA2", follow: true });
  assert.equal(r.payload.requested, true);
  const req = (await call(2, { action: "notifs" })).payload.items[0];
  assert.deepEqual([req.type, req.pending], ["follow_request", true]);
  await call(2, { action: "follow_respond", id: "user_AAA1", accept: true });
  assert.equal(notifs(2).filter((n: any) => n.type === "follow_request").length, 0);
  assert.equal(notifs(2).filter((n: any) => n.type === "follow").length, 1);
  assert.equal(notifs(1).filter((n: any) => n.type === "accepted").length, 1);
});

test("A6. deleting a default member removes its activity; acting-as sees the member's own notifications", async () => {
  const s = await createSeed({ nickname: "مریم", gender: "female", age: 24, province: "تهران", city: "تهران", bio: "" });
  await call(1, { action: "follow", id: s.anonId, follow: true });
  const mine = (await call(ADMIN_ID, { action: "notifs", actAs: s.anonId })).payload;
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].actor.id, "user_AAA1");
  const { deleteSeed } = await import("../../src/db/models/seeds.js");
  await deleteSeed(s._id);
  assert.equal(notifs(s._id).length, 0);
});

/* ------------------------------------------------------------ gifts */
test("P1. a gift to a default member works (sender pays, the member's wallet stays empty)", async () => {
  const s = await createSeed({ nickname: "مریم", gender: "female", age: 24, province: "تهران", city: "تهران", bio: "" });
  const r = await call(1, { action: "gift_send", id: s.anonId, giftId: "cake", clientId: "toseed-001" });
  assert.equal(r.status, 200);
  assert.ok(col("mini_gifts").all().some((g: any) => g.receiverId === s._id));
  assert.ok(col("users").byId(1).relicBalance < 500);
  assert.equal(col("users").byId(s._id).relicBalance, 0);
});

test("P2. a picture (cut-out PNG / photo) is a valid gift format and shows up in the catalogue", async () => {
  const g = await addCustomGift({ name: "تاج", emoji: "🎁", price: 50, sticker: { fileId: "F1", uniqueId: "U1", format: "png" }, createdBy: OWNER_ID });
  const card = (await giftCatalog()).find((c) => c.id === g._id)!;
  assert.deepEqual(card.anim, { format: "png", v: "U1" });
  const viaApi = (await call(1, { action: "gift_catalog" })).payload.items.find((c: any) => c.id === g._id);
  assert.equal(viaApi.anim.format, "png");
  assert.match(viaApi.anim.url, /^\/api\/miniapp\?g=/);
});

/* ------------------------------------------------------------ admin */
test("S1. one-message member: six lines parse; bad lines say which line is wrong", () => {
  const ok = parseQuickSeed("مریم\nزن\n۲۴\nتهران\nتهران\nعاشق کتاب");
  assert.ok(ok && ok.ok);
  assert.deepEqual(ok && ok.ok && { g: ok.data.gender, a: ok.data.age, p: ok.data.province, b: ok.data.bio }, { g: "female", a: 24, p: "تهران", b: "عاشق کتاب" });
  const bad = parseQuickSeed("مریم\nزن\n24\nتهران\nشهرِ-نامعتبر");
  assert.ok(bad && !bad.ok && /شهر/.test(bad.error));
  assert.equal(parseQuickSeed("مریم"), null, "a lone name continues the step-by-step flow");
});

test("S2. admin keyboard: coins / Navagram / default members are direct categories", async () => {
  await h.text(OWNER_ID, "/start");
  const kb = JSON.stringify(h.last("sendMessage", OWNER_ID)?.payload.reply_markup);
  for (const t of ["🪙 سکه‌ها", "📸 نوا گرام", "🎭 ممبرهای پیش‌فرض"]) assert.match(kb, new RegExp(t));
  await h.text(OWNER_ID, "🎭 ممبرهای پیش‌فرض");
  assert.match(JSON.stringify(h.last("sendMessage", OWNER_ID)?.payload.reply_markup), /ساخت ممبر جدید/);
  await h.text(OWNER_ID, "➕ ساخت ممبر جدید");
  assert.match(String(h.last("sendMessage", OWNER_ID)?.payload.text), /یک پیام/);
  await h.text(OWNER_ID, "مریم\nمرد\n30\nتهران\nتهران");
  assert.equal(col("users").all().filter((u: any) => u.isSeed).length, 1);
});
