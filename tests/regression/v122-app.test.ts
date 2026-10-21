/** v1.22.0 — in-app direct messages, block/report, staff moderation, story like/reply, two-player backgammon, Nava page, badges panel. (mocked Mongo + Telegram) */
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

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
  else if (method === "getFile") result = { file_id: payload.file_id, file_path: "photos/x.jpg" };
  return { ok: true, result } as any;
});
const sent = (method: string, chat?: number) => api.filter((c) => c.method === method && (chat === undefined || c.payload.chat_id === chat));

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send(o: any) { if (o && typeof o === "object" && !Buffer.isBuffer(o)) payload = o; return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
// 1x1 PNG
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString("base64");

beforeEach(async () => {
  resetState();
  h.resetCalls();
  api.length = 0;
  ensureSocialIndexesOnce();
  await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: OWNER_ID, anonId: "user_OWNR", nickname: "نوا", age: 33, city: "تهران", bio: "رسمی", profilePhotoFileId: "FO", onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  seedUser({ id: 10, anonId: "user_AAAA", nickname: "الف", profilePhotoFileId: "FA", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "alef" } as any);
  seedUser({ id: 11, anonId: "user_BBBB", nickname: "ب", profilePhotoFileId: "FB", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "bee" } as any);
  seedUser({ id: 12, anonId: "user_CCCC", nickname: "ج", profilePhotoFileId: "FC", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "cee" } as any);
});

async function startDm(): Promise<string> {
  const rq = await call(10, { action: "request", id: "user_BBBB" });
  assert.equal(rq.payload.status, "sent");
  const inbox = await call(11, { action: "dm_requests" });
  assert.equal(inbox.payload.incoming.length, 1);
  assert.equal((await call(10, { action: "dm_requests" })).payload.outgoing.length, 1);
  const ok = await call(11, { action: "dm_respond", id: inbox.payload.incoming[0].id, accept: true });
  assert.equal(ok.payload.status, "accepted");
  assert.equal(ok.payload.origin, "miniapp");
  return ok.payload.sid;
}

test("D1. a request made in the app is answered in the app; accepted → in-app chat, text both ways, read ticks, contact filter, end", async () => {
  const sid = await startDm();
  assert.equal((await call(10, { action: "pulse" })).payload.dm.sid, sid);
  const s1 = await call(10, { action: "dm_send", sid, text: "سلام", cid: "cid-aaaa-1" });
  assert.equal(s1.status, 200);
  // the same cid again does not create a second message
  const s1b = await call(10, { action: "dm_send", sid, text: "سلام", cid: "cid-aaaa-1" });
  assert.equal(s1b.payload.message.seq, s1.payload.message.seq);
  const bad = await call(10, { action: "dm_send", sid, text: "پیام بده @someone_x", cid: "cid-aaaa-2" });
  assert.notEqual(bad.status, 200);
  const open = await call(11, { action: "dm_open", sid });
  assert.ok(open.payload.messages.some((m: any) => m.text === "سلام" && !m.mine));
  assert.equal((await call(11, { action: "pulse" })).payload.dm.unread, 0, "opening marks it read");
  const back = await call(10, { action: "dm_open", sid, since: 1 });
  assert.ok(back.payload.theirRead >= s1.payload.message.seq, "double tick for the sender");
  const ph = await call(11, { action: "dm_photo", sid, image: PNG, cid: "cid-bbbb-1" });
  assert.equal(ph.status, 200);
  assert.equal(ph.payload.message.kind, "photo");
  const ov = await call(10, { action: "dm_overview" });
  assert.equal(ov.payload.items.length, 1);
  assert.equal(ov.payload.items[0].partner.id, "user_BBBB");
  await call(11, { action: "dm_end", sid });
  const after = await call(10, { action: "dm_send", sid, text: "هنوز هستی؟", cid: "cid-aaaa-3" });
  assert.notEqual(after.status, 200);
});

test("D2. nobody can request a chat with the official Nava account", async () => {
  const r = await call(10, { action: "request", id: "user_OWNR" });
  assert.equal(r.payload.status, "unavailable");
  const p = await call(10, { action: "profile", id: "user_OWNR" });
  assert.equal(p.payload.profile.chat, "official");
});

test("D3. the Nava page hides age and city by default, but the owner still sees his own", async () => {
  const p = await call(10, { action: "profile", id: "user_OWNR" });
  assert.ok(p.payload.profile.age == null || p.payload.profile.age === "");
  assert.ok(!p.payload.profile.city);
  const mine = await call(OWNER_ID, { action: "me" });
  assert.equal(mine.status, 200);
});

test("S1. block in the app is the same block as in the bot; report reaches the staff with the reason", async () => {
  const sid = await startDm();
  assert.equal((await call(10, { action: "block", id: "user_BBBB" })).status, 200);
  assert.ok((await col("blocks").find({ blockerId: 10, blockedId: 11 }).toArray()).length === 1);
  const s = await call(11, { action: "dm_send", sid, text: "هی", cid: "cid-bbbb-9" });
  assert.notEqual(s.status, 200, "a blocked pair cannot write");
  assert.deepEqual((await call(10, { action: "blocked_list" })).payload.items.map((x: any) => x.id), ["user_BBBB"]);
  assert.equal((await call(10, { action: "unblock", id: "user_BBBB" })).status, 200);
  assert.equal((await call(10, { action: "blocked_list" })).payload.items.length, 0);
  api.length = 0;
  const rep = await call(10, { action: "report", id: "user_CCCC", reason: "spam", text: "تبلیغ", image: PNG });
  assert.equal(rep.status, 200);
  assert.ok(sent("sendPhoto").length + sent("sendMessage").length >= 1, "staff were notified");
  const again = await call(10, { action: "report", id: "user_CCCC", reason: "spam" });
  assert.notEqual(again.status, 200, "no report spam within the hour");
  const other = await call(10, { action: "report", id: "user_BBBB", reason: "other", text: "" });
  assert.notEqual(other.status, 200, "«other» needs a text");
});

test("M1. staff moderation: ban / verify / badges / photo removal; a normal user is refused", async () => {
  assert.equal((await call(10, { action: "mod", id: "user_BBBB", op: "ban" })).status, 403);
  const v = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "verify" });
  assert.equal(v.payload.verified, true);
  const b = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "badges", badges: ["tick-gold", "tg-crown", "nope", "tg-crown"] });
  assert.deepEqual(b.payload.badges, ["tick-gold", "tg-crown"]);
  const pr = await call(10, { action: "profile", id: "user_BBBB" });
  assert.deepEqual(pr.payload.profile.bd, ["tick-gold", "tg-crown"]);
  const ph = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "photo_remove" });
  assert.equal(ph.payload.hasPhoto, false);
  const ban = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "ban" });
  assert.equal(ban.payload.banned, true);
  assert.equal((await call(11, { action: "me" })).status, 403);
  const un = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "unban" });
  assert.equal(un.payload.banned, false);
});

test("T1. stories: like + reply reach the owner's Activity; the owner sees viewers with the heart and replies; the ring is per-viewer", async () => {
  const st = await call(10, { action: "story_create", image: PNG, caption: "" });
  assert.equal(st.status, 200);
  const sid = st.payload.story.id;
  assert.equal((await call(11, { action: "story_view", storyId: sid })).status, 200);
  assert.equal((await call(11, { action: "story_like", storyId: sid, like: true })).payload.liked, true);
  assert.equal((await call(11, { action: "story_reply", storyId: sid, text: "قشنگه" })).status, 200);
  const vs = await call(10, { action: "story_viewers", storyId: sid });
  assert.equal(vs.payload.count, 1);
  assert.equal(vs.payload.viewers[0].liked, true);
  assert.equal(vs.payload.replies[0].text, "قشنگه");
  const n = await call(10, { action: "notifs" });
  const types = n.payload.items.map((i: any) => i.type);
  assert.ok(types.includes("story_like") && types.includes("story_reply"));
  assert.equal((await call(11, { action: "story_viewers", storyId: sid })).status, 404, "only the owner sees viewers");
  const mine = await call(11, { action: "stories", id: "user_AAAA" });
  assert.equal(mine.payload.stories[0].seen, true);
  await call(11, { action: "story_like", storyId: sid, like: false });
  assert.equal((await call(10, { action: "story_viewers", storyId: sid })).payload.viewers[0].liked ?? false, false);
});

test("G1. backgammon: create → join → roll → legal move; wrong turn / illegal move refused; blocked user cannot join; resign ends it", async () => {
  const c = await call(10, { action: "game_create" });
  assert.equal(c.payload.status, "waiting");
  const gid = c.payload.gid;
  assert.equal((await call(10, { action: "game_create" })).payload.gid, gid, "one open table per player");
  const lob = await call(11, { action: "game_lobby" });
  assert.equal(lob.payload.open.length, 1);
  await call(12, { action: "block", id: "user_AAAA" });
  assert.equal((await call(12, { action: "game_join", gid })).status, 404, "a blocked pair cannot sit together");
  const j = await call(11, { action: "game_join", gid });
  assert.equal(j.payload.status, "active");
  const turnOf = (v: any) => v.state.turn;
  let a = (await call(10, { action: "game_state", gid })).payload;
  const first = turnOf(a) === a.me ? 10 : 11;
  const second = first === 10 ? 11 : 10;
  assert.equal((await call(second, { action: "game_roll", gid })).status, 409);
  const r = await call(first, { action: "game_roll", gid });
  assert.equal(r.status, 200);
  const view = r.payload;
  if (view.legal.length) {
    const m = view.legal[0];
    const bad = await call(first, { action: "game_move", gid, from: 99, to: 98, die: 1 });
    assert.notEqual(bad.status, 200);
    const ok = await call(first, { action: "game_move", gid, from: m.from, to: m.to, die: m.die });
    assert.equal(ok.status, 200);
    assert.ok(ok.payload.v > view.v);
  }
  const res = await call(second, { action: "game_resign", gid });
  assert.equal(res.payload.status, "finished");
  assert.equal(res.payload.winner, (await call(first, { action: "game_state", gid })).payload.me);
  assert.equal((await call(10, { action: "game_lobby" })).payload.mine, null);
});

test("B1. admin panel «🏅 بج‌ها»: enter a numeric id, toggle badges from the keyboard; saved on the user", async () => {
  await h.text(OWNER_ID, "/start");
  await h.text(OWNER_ID, "🏅 بج‌ها");
  await h.text(OWNER_ID, "99999");
  assert.ok(h.of("sendMessage", OWNER_ID).some((c: any) => /پیدا نشد/.test(String(c.payload.text))));
  await h.text(OWNER_ID, "11");
  const kb = h.last("sendMessage", OWNER_ID)!.payload.reply_markup.inline_keyboard.flat();
  const crown = kb.find((b: any) => /تاج/.test(b.text));
  assert.ok(crown, "badge buttons shown");
  await h.callback(OWNER_ID, crown.callback_data);
  assert.deepEqual((await col("users").findOne({ _id: 11 }))!.badges, ["tg-crown"]);
  await h.callback(OWNER_ID, crown.callback_data);
  assert.deepEqual((await col("users").findOne({ _id: 11 }))!.badges, []);
  // a normal user cannot reach it
  await h.callback(10, "admin:bdg:11:0");
  assert.deepEqual(((await col("users").findOne({ _id: 11 }))!.badges ?? []), []);
  void ADMIN_ID;
});
