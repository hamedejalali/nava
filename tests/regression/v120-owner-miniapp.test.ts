/** v1.20.0 — the owner's own mini-app page: no approvals, optional age/bio, visibility switches, infinite XP. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { ensureChatRequestIndexes } = await import("../../src/db/models/chatRequest.js");
const { setGiftPrice, setGiftUnique, getMiniSettings } = await import("../../src/services/nava/settings.js");
const { addCustomGift, removeCustomGift } = await import("../../src/services/nava/giftDefs.js");

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
  else if (method === "getFile") result = { file_id: payload.file_id, file_path: "stickers/x.tgs" };
  return { ok: true, result } as any;
});
const sentApi = (method: string, chat?: number) => api.filter((c) => c.method === method && (chat === undefined || c.payload.chat_id === chat));

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
async function get(query: Record<string, string>) {
  let status = 200; let sent: any; const headers: Record<string, string> = {};
  const res: any = { setHeader(k: string, v: string) { headers[k] = v; }, status(c: number) { status = c; return res; }, send(b: any) { sent = b; return res; }, end() { return res; }, json() { return res; } };
  await handler({ method: "GET", query } as any, res);
  return { status, sent, headers };
}

beforeEach(async () => {
  resetState();
  h.resetCalls();
  api.length = 0;
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مویا", age: 30, bio: "bio", city: "تهران", relicBalance: 0, relicInitialized: true, miniUsername: "nava", miniUsernameLower: "nava" });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", age: 22, bio: "hi", relicBalance: 50, relicInitialized: true, miniUsername: "sara", miniUsernameLower: "sara" });
});

test("O1. owner changes name and age on his own page at once — no edit request, nobody is asked", async () => {
  const a = await call(OWNER_ID, { action: "request_change", field: "nickname", value: "Moyagram Official" });
  assert.equal(a.payload.status, "applied");
  assert.equal(col("users").byId(OWNER_ID).nickname, "Moyagram Official");
  const b = await call(OWNER_ID, { action: "request_change", field: "age", value: "41" });
  assert.equal(b.payload.status, "applied");
  assert.equal(col("users").byId(OWNER_ID).age, 41);
  assert.equal(col("edit_requests").all().length, 0, "no approval request created");
  assert.equal(sentApi("sendMessage").length, 0, "nobody notified");
});

test("O2. the owner's age is optional: an empty value removes it; garbage is refused", async () => {
  assert.equal((await call(OWNER_ID, { action: "request_change", field: "age", value: "" })).payload.status, "applied");
  assert.equal(col("users").byId(OWNER_ID).age, undefined);
  assert.notEqual((await call(OWNER_ID, { action: "request_change", field: "age", value: "abc" })).status, 200);
  assert.notEqual((await call(OWNER_ID, { action: "request_change", field: "age", value: "999" })).status, 200);
});

test("O3. visibility switches: the owner hides age/bio/location/gifts/stats; others see nothing; he still sees everything", async () => {
  const r = await call(OWNER_ID, { action: "set_visibility", hide: { age: true, bio: true, location: true, stats: true, bogus: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.payload.hide, { age: true, bio: true, location: true, stats: true });
  const seen = (await call(2, { action: "profile", id: "user_OWN0" })).payload.profile;
  assert.equal(seen.age, null);
  assert.equal(seen.bio, "");
  assert.equal(seen.city, null);
  assert.equal(seen.followers, 0);
  const mine = (await call(OWNER_ID, { action: "me" })).payload.me;
  assert.equal(mine.age, 30);
  assert.equal(mine.bio, "bio");
  assert.equal(mine.hide.age, true);
  // switching back shows it again
  await call(OWNER_ID, { action: "set_visibility", hide: { age: false, bio: false } });
  const again = (await call(2, { action: "profile", id: "user_OWN0" })).payload.profile;
  assert.equal(again.age, 30);
  assert.equal(again.bio, "bio");
});

test("O4. hidden gifts are not listed to others", async () => {
  col("mini_gifts").seed({ _id: "x1", pub: "PUBX1", senderId: 2, receiverId: OWNER_ID, giftId: "rose", price: 10, message: "", createdAt: new Date() } as any);
  assert.equal((await call(2, { action: "gifts", id: "user_OWN0" })).payload.total, 1);
  await call(OWNER_ID, { action: "set_visibility", hide: { gifts: true } });
  const l = (await call(2, { action: "gifts", id: "user_OWN0" })).payload;
  assert.deepEqual([l.total, l.items.length], [0, 0]);
  assert.equal((await call(OWNER_ID, { action: "gifts", id: "user_OWN0" })).payload.total, 1);
});

test("O5. only the owner can use the switches or the direct edit path; ordinary users keep the approval flow", async () => {
  const bad = await call(2, { action: "set_visibility", hide: { age: true } });
  assert.notEqual(bad.status, 200);
  assert.equal(col("users").byId(2).profileHide, undefined);
  await call(2, { action: "request_change", field: "age", value: "25" });
  assert.equal(col("users").byId(2).age, 22, "an ordinary user's age is NOT applied directly");
});

test("O6. the owner's profile marks infinite XP; ordinary users do not", async () => {
  const mine = (await call(OWNER_ID, { action: "me" })).payload.me;
  assert.equal(mine.unlimited, true);
  assert.equal(mine.isOwnerPage, true);
  const them = (await call(2, { action: "me" })).payload.me;
  assert.notEqual(them.unlimited, true);
});
