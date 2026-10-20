/** v1.21.0 — registering inside the Mini App: same fields and ending as the bot, atomic, bonus once, bot informed. (mocked) */
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
});
const good = { gender: "female", age: 24, province: "تهران", city: "تهران", nickname: "مریم" };

test("OB1. a brand-new Telegram user (no bot /start yet) gets the question lists", async () => {
  const r = await call(777, { action: "onboard_state" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.completed, false);
  assert.ok(r.payload.provinces.length >= 31);
  assert.equal(r.payload.minAge, 9);
  const c = await call(777, { action: "onboard_cities", province: "تهران" });
  assert.ok(c.payload.cities.some((x: any) => x.name === "تهران"));
  assert.equal((await call(777, { action: "onboard_cities", province: "نیست" })).status, 400);
});

test("OB2. saving finishes the account exactly like the bot: COMPLETED, fa, profile bonus once, bot gets the completion + menu", async () => {
  const r = await call(777, { action: "onboard_save", ...good });
  assert.deepEqual(r.payload, { status: "completed" });
  const u = col("users").byId(777);
  assert.deepEqual([u.onboardingStep, u.languageCode, u.gender, u.age, u.province, u.city, u.nickname], ["COMPLETED", "fa", "female", 24, "تهران", "تهران", "مریم"]);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "PROFILE_COMPLETION_REWARD").length, 1);
  assert.ok(sentApi("sendMessage", 777).length >= 2, "completion message + main menu");
  // afterwards the normal app works for him
  assert.equal((await call(777, { action: "me" })).status, 200);
  // second save / double tap: nothing changes, no second bonus
  const again = await call(777, { action: "onboard_save", ...good, nickname: "دیگری" });
  assert.deepEqual(again.payload, { status: "already" });
  assert.equal(col("users").byId(777).nickname, "مریم");
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "PROFILE_COMPLETION_REWARD").length, 1);
});

test("OB3. validation: bad gender/age/province/city/nickname are refused and nothing is saved", async () => {
  for (const [bad, field] of [[{ gender: "x" }, "gender"], [{ age: 5 }, "age"], [{ age: 120 }, "age"], [{ age: "ab" }, "age"], [{ province: "نیست" }, "province"], [{ city: "شیراز" }, "city"], [{ nickname: "Maryam" }, "nickname"], [{ nickname: "" }, "nickname"]] as const) {
    const r = await call(777, { action: "onboard_save", ...good, ...bad });
    assert.equal(r.status, 400);
    assert.equal(r.payload.error, `invalid_${field}`);
  }
  assert.notEqual(col("users").byId(777)?.onboardingStep, "COMPLETED");
});

test("OB4. continues where the bot stopped (known answers returned); parallel double submit completes once", async () => {
  await call(778, { action: "onboard_state" });
  col("users").updateOne({ _id: 778 }, { $set: { gender: "male", onboardingStep: "AGE_PENDING" } });
  const st = (await call(778, { action: "onboard_state" })).payload;
  assert.equal(st.gender, "male");
  const rs = await Promise.all([call(778, { action: "onboard_save", ...good, gender: "male" }), call(778, { action: "onboard_save", ...good, gender: "male" })]);
  assert.equal(rs.filter((x) => x.payload.status === "completed").length, 1);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "PROFILE_COMPLETION_REWARD" && t.userId === 778).length, 1);
});

test("OB5. needs valid signed initData; a banned user cannot register", async () => {
  let status = 0; const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json() { return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { action: "onboard_save", initData: "hash=bad&auth_date=1", ...good } } as any, res);
  assert.equal(status, 401);
  await call(779, { action: "onboard_state" });
  col("users").updateOne({ _id: 779 }, { $set: { banned: true } });
  assert.equal((await call(779, { action: "onboard_save", ...good })).status, 403);
});
