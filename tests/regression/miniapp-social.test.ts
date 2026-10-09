/** Instagram-style Mini App backend (v1.15.0): username claim, feed/search, likes, bio, photo upload, staff gate. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN = "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.OWNER_ID = "900";
installFakeMongo();
const S = await import("../../src/services/miniappSocial.js");
const { default: handler } = await import("../../api/miniapp.js");

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}

beforeEach(async () => {
  resetFakeMongo();
  S.ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: 1, profilePhotoFileId: "P1", anonId: "user_AAA1" });
  seedUser({ id: 2, profilePhotoFileId: "P2", anonId: "user_AAA2", miniUsername: "Taken_Name", miniUsernameLower: "taken_name" });
  seedUser({ id: 3, profilePhotoFileId: "P3", anonId: "user_AAA3", miniUsername: "sara", miniUsernameLower: "sara", likesCount: 4 });
  seedUser({ id: 4, anonId: "user_AAA4" }); // no photo -> never listed
  seedUser({ id: 5, profilePhotoFileId: "P5", anonId: "user_AAA5", banned: true });
  seedUser({ id: 900, anonId: "user_OWN0" });
});

test("username: format rules + 'already chosen' (case-insensitive) + own name stays available to self", async () => {
  const me: any = col("users").byId(1);
  assert.equal(S.usernameFormatError("ab"), "too_short");
  assert.equal(S.usernameFormatError("a".repeat(30)), "too_long");
  assert.equal(S.usernameFormatError("hi there"), "bad_chars");
  assert.equal(S.usernameFormatError(".abc"), "bad_dots");
  assert.equal(S.usernameFormatError("a..b"), "bad_dots");
  assert.equal(S.usernameFormatError("12345"), "bad_chars");
  assert.equal(S.usernameFormatError("admin"), "reserved");
  assert.equal(S.usernameFormatError("@Hamed"), null);
  assert.deepEqual(await S.checkUsername(me, "taken_NAME"), { available: false, reason: "taken" });
  assert.equal(await S.setMiniUsername(me, "@Hamed"), "Hamed");
  assert.equal(col("users").byId(1).miniUsernameLower, "hamed");
  await assert.rejects(S.setMiniUsername(col("users").byId(3) as any, "hamed"), (e: any) => e.code === "taken");
  assert.equal((await S.checkUsername(col("users").byId(1) as any, "HAMED")).available, true); // own name
});

test("two simultaneous claims of the same username: exactly one wins", async () => {
  const r = await Promise.allSettled([S.setMiniUsername(col("users").byId(1) as any, "newname"), S.setMiniUsername(col("users").byId(3) as any, "NewName")]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(col("users").all().filter((u: any) => u.miniUsernameLower === "newname").length, 1);
});

test("feed/explore list only eligible users (photo, not banned, not me), paged; search is prefix on username", async () => {
  const f = await call(1, { action: "feed_page", offset: 0 });
  assert.equal(f.status, 200);
  assert.deepEqual(f.payload.items.map((c: any) => c.id).sort(), ["user_AAA2", "user_AAA3"]);
  assert.equal(f.payload.hasMore, false);
  assert.equal(f.payload.items.some((c: any) => "telegramId" in c || "_id" in c), false); // no telegram ids leak
  const top = await call(1, { action: "explore", offset: 0 });
  assert.equal(top.payload.items[0].id, "user_AAA3"); // most liked first
  assert.deepEqual((await call(1, { action: "search", q: "@SA" })).payload.items.map((c: any) => c.username), ["sara"]);
  assert.deepEqual((await call(1, { action: "search", q: "zzz" })).payload.items, []);
  assert.deepEqual((await call(1, { action: "search", q: "bad query!" })).payload.items, []);
});

test("like is idempotent both ways and never goes negative", async () => {
  const a = await call(1, { action: "like", id: "user_AAA3", like: true });
  const b = await call(1, { action: "like", id: "user_AAA3", like: true });
  assert.deepEqual([a.payload.likes, b.payload.likes, b.payload.liked], [5, 5, true]);
  assert.equal(col("users").byId(3).likesCount, 5);
  const c = await call(1, { action: "like", id: "user_AAA3", like: false });
  const d = await call(1, { action: "like", id: "user_AAA3", like: false });
  assert.deepEqual([c.payload.likes, d.payload.likes, d.payload.liked], [4, 4, false]);
  assert.equal((await call(1, { action: "like", id: "user_AAA1", like: true })).status, 404); // self
  assert.equal((await call(1, { action: "like", id: "user_AAA5", like: true })).status, 404); // banned
  const card = (await call(1, { action: "user", id: "user_AAA3" })).payload.user;
  assert.equal(card.liked, false);
});

test("bio: trimmed, capped, shows in the bot's profile text together with the @username", async () => {
  const r = await call(1, { action: "set_bio", bio: "  سلام\n\n\n\nدنیا  " });
  assert.equal(r.payload.bio, "سلام\n\nدنیا");
  assert.equal((await call(1, { action: "set_bio", bio: "x".repeat(151) })).payload.error, "bio_too_long");
  assert.equal(col("users").byId(1).bio, "سلام\n\nدنیا");
  await call(1, { action: "set_username", username: "Hamed" });
  const { buildProfileText } = await import("../../src/features/matching/profile.js");
  const text = buildProfileText("fa", col("users").byId(1) as any);
  assert.match(text, /@Hamed/);
  assert.match(text, /سلام/);
  const taken = await call(1, { action: "set_username", username: "sara" });
  assert.equal(taken.status, 409); assert.equal(taken.payload.error, "taken");
});

test("photo upload: safe image auto-approved, flagged goes to admins as pending, cooldown + bad files rejected", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]).toString("base64");
  const sent: any[] = [];
  const api: any = {
    sendPhoto: async (chat: number, _f: any, o?: any) => { sent.push({ chat, o }); return { photo: [{ file_id: "SMALL" }, { file_id: "BIG" + sent.length }] }; },
    getFile: async () => ({ file_path: "p.jpg" }),
    sendMessage: async () => ({}),
  };
  const me: any = col("users").byId(1);
  const ok = await S.uploadProfilePhoto(me, "data:image/jpeg;base64," + jpeg, { api, check: async () => ({ serviceUnavailable: false, flagged: false, score: 0, classification: "safe" }), recipients: async () => [900] });
  assert.equal(ok, "approved");
  assert.equal(col("users").byId(1).profilePhotoFileId, "BIG1");
  await assert.rejects(S.uploadProfilePhoto(col("users").byId(1) as any, jpeg, { api, check: async () => ({ serviceUnavailable: false, flagged: false, score: 0, classification: "safe" }), recipients: async () => [900] }), (e: any) => e.code === "too_fast");
  // flagged user 3 -> pending + admin copy with approve/reject buttons, photo NOT changed
  const pend = await S.uploadProfilePhoto(col("users").byId(3) as any, jpeg, { api, check: async () => ({ serviceUnavailable: true, flagged: true, score: 1, classification: "x" }), recipients: async () => [900] });
  assert.equal(pend, "pending");
  assert.equal(col("users").byId(3).profilePhotoFileId, "P3");
  assert.ok(sent.some((s) => s.chat === 900 && s.o?.reply_markup));
  assert.equal(col("image_moderation").all().filter((d: any) => d.status === "pending").length, 1);
  assert.equal((await S.myProfile(col("users").byId(3) as any)).photoPending, true);
  await assert.rejects(async () => S.decodeImage("data:image/jpeg;base64,AAAA"), (e: any) => e.code === "bad_image");
  await assert.rejects(async () => S.decodeImage(Buffer.alloc(500, 1).toString("base64")), (e: any) => e.code === "bad_image");
  await assert.rejects(S.uploadProfilePhoto(col("users").byId(4) as any, jpeg, { api, check: async () => ({ serviceUnavailable: false, flagged: false, score: 0, classification: "safe" }), recipients: async () => [] }), (e: any) => e.code === "unavailable");
});

test("whoami: staff -> monitor role; normal user -> social app; unregistered / forged -> rejected", async () => {
  assert.deepEqual((await call(900, { action: "whoami" })).payload, { role: "staff" });
  const u = await call(1, { action: "whoami" });
  assert.equal(u.payload.role, "user"); assert.equal(u.payload.me.id, "user_AAA1");
  assert.equal((await call(999, { action: "whoami" })).status, 403);
  let status = 0; const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json() { return res; } };
  await handler({ method: "POST", body: { action: "feed_page", initData: "x" } } as any, res);
  assert.equal(status, 401);
});
