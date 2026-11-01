/** v1.28.0 — staff permissions are enforced on the SERVER for the mini-app / monitor APIs (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { default: monitorHandler } = await import("../../api/monitor.js");
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

async function mon(userId: number, action: string) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await monitorHandler({ method: "POST", body: { initData: init(userId), action } } as any, res);
  return { status, payload };
}
async function setAdmin(set: Record<string, unknown>) {
  const { getDb } = await import("../../src/db/connect.js");
  await (await getDb()).collection<any>("users").updateOne({ _id: ADMIN_ID }, { $set: set });
}
beforeEach(async () => {
  resetState();
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مویا", age: 30, relicInitialized: true });
  seedUser({ id: ADMIN_ID, anonId: "user_ADM9", nickname: "ادمین", age: 30, relicInitialized: true });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", age: 22, relicInitialized: true });
});

test("S1. admin without the ban permission cannot ban through the mini-app API; with it, can", async () => {
  await setAdmin({ adminPerms: { ban: false } });
  const a = await call(ADMIN_ID, { action: "mod", op: "ban", id: "user_AAA2" });
  assert.equal(a.status, 403);
  assert.notEqual(col("users").byId(2).banned, true);
  await setAdmin({ adminPerms: { ban: true } });
  const b = await call(ADMIN_ID, { action: "mod", op: "ban", id: "user_AAA2" });
  assert.equal(b.status, 200);
  assert.equal(col("users").byId(2).banned, true);
});

test("S2. permissions are re-read on every request (revoked right takes effect at once)", async () => {
  await setAdmin({ adminPerms: { verify: true } });
  assert.equal((await call(ADMIN_ID, { action: "mod", op: "verify", id: "user_AAA2" })).status, 200);
  await setAdmin({ adminPerms: { verify: false } });
  assert.equal((await call(ADMIN_ID, { action: "mod", op: "unverify", id: "user_AAA2" })).status, 403);
});

test("S3. a banned static (env) admin loses staff rights", async () => {
  await setAdmin({ banned: true });
  assert.equal((await mon(ADMIN_ID, "snapshot")).status, 403);
  assert.equal((await call(ADMIN_ID, { action: "mod", op: "ban", id: "user_AAA2" })).status, 403);
});

test("S4. owner-only and reset_user: an ordinary admin cannot escalate", async () => {
  await setAdmin({ adminPerms: { ban: true, verify: true, badges: true, users: true } });
  assert.equal((await call(ADMIN_ID, { action: "mod", op: "reset_user", id: "user_AAA2" })).status, 403);
  assert.equal((await call(ADMIN_ID, { action: "gift_remove", id: "x" })).status, 403);
});

test("S5. monitor stats and account switcher need their permissions", async () => {
  await setAdmin({ adminPerms: { stats: false, seeds: false } });
  assert.equal((await mon(ADMIN_ID, "snapshot")).status, 403);
  assert.equal((await mon(ADMIN_ID, "accounts")).status, 403);
  assert.equal((await call(ADMIN_ID, { action: "accounts" })).status, 403);
  assert.equal((await mon(OWNER_ID, "accounts")).status, 200);
});

test("S6. a non-staff user gets nothing from staff actions", async () => {
  assert.equal((await call(2, { action: "mod", op: "ban", id: "user_OWN0" })).status, 403);
  assert.equal((await mon(2, "snapshot")).status, 403);
});
