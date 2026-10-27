/** v1.27.0 — guest (started the bot, registration unfinished) may play at a shared table; everything else stays closed; game_share is routed. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");

const sent: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  sent.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
  if (method === "savePreparedInlineMessage") result = { id: "PREP1" };
  return { ok: true, result } as any;
});
function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "x" }) };
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
const bal = async (id: number) => ((await col("users").findOne({ _id: id })) as any).relicBalance as number;
const msgsTo = (id: number) => sent.filter((s) => s.method === "sendMessage" && s.payload.chat_id === id).map((s) => String(s.payload.text));
const age = async (gid: string, ms: number) => { await col("bg_games").updateOne({ _id: gid }, { $set: { updatedAt: new Date(Date.now() - ms) } }); };


beforeEach(async () => {
  resetState(); h.resetCalls(); sent.length = 0;
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: 10, anonId: "user_AAAA", nickname: "alef", profilePhotoFileId: "F10", onboardingStep: "COMPLETED", relicBalance: 50, miniUsername: "alef" } as any);
  seedUser({ id: 20, anonId: "user_GGGG", nickname: "guest", onboardingStep: "ASK_AGE", relicBalance: 0 } as any);
});

test("G1. a guest sits at the host's free table and plays; whoami / other sections stay closed", async () => {
  const c = await call(10, { action: "game_create", stake: 0 });
  assert.equal(c.status, 200);
  assert.equal((await call(20, { action: "whoami" })).payload.error, "not_registered");
  assert.equal((await call(20, { action: "home" })).status, 403);
  assert.equal((await call(20, { action: "dm_overview" })).status, 403);
  const j = await call(20, { action: "game_join", gid: c.payload.gid });
  assert.equal(j.status, 200, JSON.stringify(j.payload));
  const st = await call(20, { action: "game_state", gid: c.payload.gid });
  assert.equal(st.status, 200);
  assert.equal(st.payload.status, "active");
  const lob = await call(20, { action: "game_lobby" });
  assert.equal(lob.status, 200);
});

test("G2. a guest cannot create or share tables, and cannot join a staked table", async () => {
  assert.equal((await call(20, { action: "game_create", stake: 0 })).status, 403);
  const c = await call(10, { action: "game_create", stake: 10 });
  const j = await call(20, { action: "game_join", gid: c.payload.gid });
    assert.equal(j.payload.error, "insufficient");
  assert.equal((await call(20, { action: "game_share", gid: c.payload.gid })).status, 403);
  assert.equal(((await col("users").findOne({ _id: 20 })) as any).relicBalance, 0);
});

test("G3. an unknown or banned person gets nothing; the host can share (game_share is routed)", async () => {
  assert.equal((await call(99, { action: "game_join", gid: "x" })).status, 403);
  seedUser({ id: 21, anonId: "user_BBBB", nickname: "bad", onboardingStep: "ASK_AGE", banned: true } as any);
  const c = await call(10, { action: "game_create", stake: 0 });
  assert.equal((await call(21, { action: "game_join", gid: c.payload.gid })).payload.error, "banned");
  const sh = await call(10, { action: "game_share", gid: c.payload.gid });
  assert.equal(sh.status, 200, JSON.stringify(sh.payload));
  assert.equal(sh.payload.id, "PREP1");
  assert.ok(/start=g_/.test(sh.payload.link));
});
