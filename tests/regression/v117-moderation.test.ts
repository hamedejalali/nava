/** v1.17.0 — Mini App moderation: owner opens/deletes anything, users report posts, "chatting with you" badge. (mocked) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, seedChatSession, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  return { ok: true, result: /^send/.test(method) ? { message_id: 700 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" } } : true } as any;
});
const sentApi = (method: string, chat?: number) => api.filter((c) => c.method === method && (chat === undefined || c.payload.chat_id === chat));

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const tick = () => new Promise((r) => setTimeout(r, 3));
async function call(userId: number, body: any) {
  if (/_create$|_add$/.test(body.action)) await tick();
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
const JPEG = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]).toString("base64");

beforeEach(async () => {
  resetState(); h.resetCalls(); api.length = 0;
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", profilePhotoFileId: "P1", profilePhotoAt: new Date(Date.now() - 5000) });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", profilePhotoFileId: "P2", profilePhotoAt: new Date(Date.now() - 4000) });
  seedUser({ id: 3, anonId: "user_AAA3", nickname: "نیما" });
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  seedUser({ id: ADMIN_ID, anonId: "user_ADM1", nickname: "ادمین" });
});

test("M1. owner (and admin) can delete anybody's post, story and comment; others get 404/forbidden; the author is told", async () => {
  const post = (await call(1, { action: "post_create", image: JPEG, caption: "x" })).payload.item.pid;
  const story = (await call(1, { action: "story_create", image: JPEG })).payload;
  const cm = (await call(2, { action: "comment_add", pid: post, text: "hi" })).payload;
  const commentId = cm.item?.id ?? cm.comment?.id ?? cm.id;

  assert.equal((await call(3, { action: "post_delete", pid: post })).status, 404);
  assert.equal((await call(3, { action: "comment_delete", commentId })).status, 403);
  assert.equal(col("mini_posts").all().length, 1);

  assert.equal((await call(ADMIN_ID, { action: "comment_delete", commentId })).status, 200);
  assert.equal(col("mini_comments").all().length, 0);
  assert.equal((await call(OWNER_ID, { action: "post_delete", pid: post })).status, 200);
  assert.equal(col("mini_posts").all().length + col("mini_media").all().filter((m: any) => m.kind === "post").length, 0);
  assert.ok(sentApi("sendMessage", 1).some((c) => /حذف شد/.test(String(c.payload.text))));
  assert.ok(col("admin_activity_log").all().some((l: any) => /miniapp_post_delete/.test(JSON.stringify(l))));
  const sid = story.item?.id ?? story.story?.id ?? story.id;
  if (sid) {
    assert.equal((await call(OWNER_ID, { action: "story_delete", storyId: sid })).status, 200);
    assert.equal(col("mini_stories").all().length, 0);
  }
});

test("M2. the owner can open a banned or blocking user's profile; an ordinary user cannot", async () => {
  col("users").updateOne({ _id: 2 }, { $set: { banned: true } });
  assert.equal((await call(3, { action: "profile", id: "user_AAA2" })).status, 404);
  const r = await call(OWNER_ID, { action: "profile", id: "user_AAA2" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.profile.name, "سارا");
});

test("M3. report: one per person, not your own, not a missing post; the owner gets the picture with delete / ban / ignore buttons", async () => {
  const pid = (await call(1, { action: "post_create", image: JPEG, caption: "بد" })).payload.item.pid;
  assert.equal((await call(1, { action: "post_report", pid, reason: "nudity" })).payload.error, "self");
  assert.equal((await call(2, { action: "post_report", pid: "nopost12345", reason: "nudity" })).status, 404);
  assert.equal((await call(2, { action: "post_report", pid, reason: "nudity" })).payload.status, "reported");
  assert.equal((await call(2, { action: "post_report", pid, reason: "spam" })).payload.status, "duplicate");
  assert.equal(col("post_reports").all().length, 1);
  await h.settle();
  const msg = sentApi("sendPhoto", OWNER_ID)[0] ?? sentApi("sendMessage", OWNER_ID)[0];
  assert.ok(msg, "owner notified");
  const data = JSON.stringify(msg.payload.reply_markup);
  assert.match(data, new RegExp(`pr:d:${pid}`));
  assert.match(data, new RegExp(`pr:b:${pid}`));
  assert.match(data, new RegExp(`pr:i:${pid}`));
  await call(3, { action: "post_report", pid, reason: "abuse" });
  await h.settle();
  assert.equal(sentApi("sendPhoto", OWNER_ID).length + sentApi("sendMessage", OWNER_ID).length, 1, "no spam: told once at the first report");
});

test("M4. owner's decision buttons: delete / delete+ban / ignore work for admins only", async () => {
  const mk = async (u: number) => (await call(u, { action: "post_create", image: JPEG, caption: "p" })).payload.item.pid as string;
  const p1 = await mk(1); const p2 = await mk(2); const p3 = await mk(3);
  for (const p of [p1, p2, p3]) await call(OWNER_ID === 0 ? 1 : (p === p1 ? 2 : 1), { action: "post_report", pid: p, reason: "nudity" });

  await h.callback(3, `pr:d:${p1}`); // not an admin
  assert.equal(col("mini_posts").all().length, 3);

  await h.callback(OWNER_ID, `pr:d:${p1}`);
  assert.equal(col("mini_posts").all().some((p: any) => p._id === p1), false);
  assert.equal(col("post_reports").all().some((r: any) => r.postId === p1), false);

  await h.callback(OWNER_ID, `pr:b:${p2}`);
  assert.equal(col("mini_posts").all().some((p: any) => p._id === p2), false);
  assert.equal(col("users").byId(2).banned, true);

  await h.callback(OWNER_ID, `pr:i:${p3}`);
  assert.equal(col("mini_posts").all().some((p: any) => p._id === p3), true);
  assert.equal(col("post_reports").all().some((r: any) => r.postId === p3), false);
});

test("M5. profile of the person you are chatting with right now says so (with_you); others see busy", async () => {
  seedChatSession({ userA: 1, userB: 2 });
  assert.equal((await call(1, { action: "profile", id: "user_AAA2" })).payload.profile.chat, "with_you");
  assert.equal((await call(2, { action: "profile", id: "user_AAA1" })).payload.profile.chat, "with_you");
  assert.equal((await call(3, { action: "profile", id: "user_AAA2" })).payload.profile.chat, "busy");
});
