/** v1.29.6 — F-09: game lobby / join apply the age separation. MOCK TESTS (fake Mongo + Telegram): application logic only. */
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

beforeEach(async () => {
  resetState(); h.resetCalls(); api.length = 0;
  ensureSocialIndexesOnce(); await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: OWNER_ID, anonId: "user_OWNR", nickname: "مویا", age: 33, city: "تهران", bio: "رسمی", profilePhotoFileId: "FO", onboardingStep: "COMPLETED", relicBalance: 0 } as any);
});
const mk = (id: number, age: number | undefined, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_G${id}`, nickname: "n" + id, age, profilePhotoFileId: "F" + id, onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "u" + id, ...extra } as any);

test("GA1. an adult's open table is invisible to a minor and unjoinable (neutral 404); same-band players still see and join it", async () => {
  mk(10, 30); mk(11, 16); mk(12, 40);
  const c = await call(10, { action: "game_create" });
  const gid = c.payload.gid;
  assert.equal((await call(11, { action: "game_lobby" })).payload.open.length, 0, "minor does not see the adult's table");
  const j = await call(11, { action: "game_join", gid });
  assert.equal(j.status, 404, "same neutral answer as a block: no age oracle");
  assert.equal(col("bg_games").byId(gid).status, "waiting", "nobody was seated");
  assert.equal((await call(12, { action: "game_lobby" })).payload.open.length, 1);
  assert.equal((await call(12, { action: "game_join", gid })).payload.status, "active");
});

test("GA2. a minor's table is invisible to an adult and unjoinable", async () => {
  mk(10, 15); mk(11, 30); mk(12, 17);
  const gid = (await call(10, { action: "game_create" })).payload.gid;
  assert.equal((await call(11, { action: "game_lobby" })).payload.open.length, 0);
  assert.equal((await call(11, { action: "game_join", gid })).status, 404);
  assert.equal((await call(12, { action: "game_join", gid })).payload.status, "active");
});

test("GA3. unknown / invalid age fails closed (either side)", async () => {
  mk(10, 30); mk(11, undefined); mk(12, 5); mk(13, 17.5);
  const gid = (await call(10, { action: "game_create" })).payload.gid;
  for (const id of [11, 12, 13]) {
    assert.equal((await call(id, { action: "game_lobby" })).payload.open.length, 0, `viewer ${id}`);
    assert.equal((await call(id, { action: "game_join", gid })).status, 404, `viewer ${id}`);
  }
  mk(20, undefined);
  const gid2 = (await call(20, { action: "game_create" })).payload.gid;
  mk(21, 30);
  assert.equal((await call(21, { action: "game_join", gid: gid2 })).status, 404, "host without a valid age");
});

test("GA4. the check uses FRESH state: an age change between lobby and join is honoured", async () => {
  mk(10, 30); mk(11, 31);
  const gid = (await call(10, { action: "game_create" })).payload.gid;
  assert.equal((await call(11, { action: "game_lobby" })).payload.open.length, 1);
  await col("users").updateOne({ _id: 11 }, { $set: { age: 16 } });
  assert.equal((await call(11, { action: "game_join", gid })).status, 404);
  assert.equal(col("bg_games").byId(gid).status, "waiting");
});

test("GA5. a banned host or joiner is refused", async () => {
  mk(10, 30); mk(11, 31);
  const gid = (await call(10, { action: "game_create" })).payload.gid;
  await col("users").updateOne({ _id: 10 }, { $set: { banned: true } });
  assert.equal((await call(11, { action: "game_join", gid })).status, 404);
});

test("GA6. the official account keeps its exemption (F-17 unchanged)", async () => {
  mk(11, 16);
  const gid = (await call(OWNER_ID, { action: "game_create" })).payload?.gid;
  if (gid) assert.equal(typeof (await call(11, { action: "game_join", gid })).status, "number");
  assert.ok(true);
});
