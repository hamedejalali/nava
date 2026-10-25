/** v1.25.0 — backgammon: several games at once, 2-minute clock + warning, cocked dice, end notices, notification refresh. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { COCKED } = await import("../../src/services/games/backgammonGames.js");
const { pushNotif, notifKey } = await import("../../src/services/nava/notifs.js");

const sent: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  sent.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
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
  resetState(); h.resetCalls(); sent.length = 0; COCKED.p = 0;
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  for (const [id, a, n] of [[10, "user_AAAA", "alef"], [11, "user_BBBB", "bee"], [12, "user_CCCC", "cee"], [13, "user_DDDD", "dee"]] as const)
    seedUser({ id, anonId: a, nickname: n, profilePhotoFileId: "F" + id, onboardingStep: "COMPLETED", relicBalance: 50, miniUsername: n } as any);
});

async function start(host: number, guest: number, stake = 0) {
  const c = await call(host, { action: "game_create", stake });
  const j = await call(guest, { action: "game_join", gid: c.payload.gid });
  assert.equal(j.status, 200, JSON.stringify(j.payload));
  return c.payload.gid as string;
}

test("V1. several games at once, but never two against the same opponent; lobby lists them", async () => {
  const g1 = await start(10, 11);
  const g2 = await start(12, 10);
  const lob = await call(10, { action: "game_lobby" });
  assert.equal(lob.payload.mine.length, 2);
  assert.ok(lob.payload.mine.every((g: any) => g.opp));
  // 10 already plays 11 → a table of 11 is not offered and cannot be joined
  const t = await call(11, { action: "game_create" });
  assert.equal((await call(10, { action: "game_lobby" })).payload.open.length, 0);
  const j = await call(10, { action: "game_join", gid: t.payload.gid });
  assert.equal(j.status, 409);
  assert.equal(j.payload.error, "same_opponent");
  // a third opponent is fine
  const t2 = await call(13, { action: "game_create" });
  assert.equal((await call(10, { action: "game_join", gid: t2.payload.gid })).status, 200);
  assert.ok(g1 && g2);
  // pulse tells which games wait / run
  const p = await call(10, { action: "pulse" });
  assert.equal(p.payload.games.items.length, 3);
});

test("V2. max 5 unfinished games per player; one open table at a time", async () => {
  const c = await call(10, { action: "game_create" });
  assert.equal((await call(10, { action: "game_create" })).payload.gid, c.payload.gid);
  assert.equal((await call(10, { action: "game_lobby" })).payload.canCreate, false);
});

test("V3. cocked die: nothing is played, same player throws again, rollN counts it", async () => {
  const gid = await start(10, 11);
  let v = (await call(10, { action: "game_state", gid })).payload;
  const first = v.state.turn === v.me ? 10 : 11;
  COCKED.p = 1;
  const r = await call(first, { action: "game_roll", gid });
  assert.equal(r.status, 200);
  assert.equal(r.payload.roll.cocked, true);
  assert.ok([0, 1].includes(r.payload.roll.off));
  assert.equal(r.payload.canRoll, true, "must throw again");
  assert.equal(r.payload.state.remaining, null);
  assert.equal(r.payload.rollN, 1);
  COCKED.p = 0;
  const r2 = await call(first, { action: "game_roll", gid });
  assert.equal(r2.payload.rollN, 2);
  assert.ok(!r2.payload.roll.cocked);
});

test("V4. 2-minute clock: warning in Telegram at 15 s left (once), timeout after 2 min pays the pot and tells both", async () => {
  const gid = await start(10, 11, 5);
  const v = (await call(10, { action: "game_state", gid })).payload;
  const turnId = v.state.turn === v.me ? 10 : 11, other = turnId === 10 ? 11 : 10;
  assert.equal(v.idleMax, 120);
  await age(gid, 90_000);
  await call(other, { action: "game_state", gid });
  assert.equal(msgsTo(turnId).length, 0, "no warning yet");
  await age(gid, 106_000);
  await call(other, { action: "game_state", gid });
  await call(other, { action: "game_state", gid });
  const w = msgsTo(turnId);
  assert.equal(w.length, 1, "warned exactly once");
  assert.match(w[0]!, /وقتت داره تموم میشه/);
  await age(gid, 121_000);
  const done = (await call(other, { action: "game_state", gid })).payload;
  assert.equal(done.status, "finished");
  assert.equal(done.endedBy, "timeout");
  assert.equal(await bal(other), 50 - 5 + 10);
  assert.equal(await bal(turnId), 45);
  await call(turnId, { action: "game_state", gid });
  assert.equal(await bal(other), 55, "paid once");
  assert.ok(msgsTo(other).some((m) => /وقت حریفت/.test(m) && /۱۰/.test(m)));
  assert.ok(msgsTo(turnId).some((m) => /وقتت تموم شد/.test(m)));
});

test("V5. resign: the opponent is told in Telegram with the XP; the resigner is not", async () => {
  const gid = await start(10, 11, 20);
  await call(11, { action: "game_resign", gid });
  const m = msgsTo(10);
  assert.equal(m.length, 1);
  assert.match(m[0]!, /انصراف داد/);
  assert.match(m[0]!, /۴۰/);
  assert.equal(msgsTo(11).length, 0);
  assert.equal(await bal(10), 50 - 20 + 40);
});

test("V6. a repeated like refreshes its notification (time + unread) instead of keeping a stale one", async () => {
  await pushNotif(notifKey.likeProfile(10, 11), { userId: 10, actorId: 11, type: "like_profile", postId: "pp:user_BBBB" });
  await col("mini_notifs").updateOne({ _id: notifKey.likeProfile(10, 11) }, { $set: { at: new Date(Date.now() - 16 * 3600_000), seen: true } });
  await pushNotif(notifKey.likeProfile(10, 11), { userId: 10, actorId: 11, type: "like_profile", postId: "pp:user_BBBB" });
  const n: any = await col("mini_notifs").findOne({ _id: notifKey.likeProfile(10, 11) });
  assert.equal(n.seen, false);
  assert.ok(Date.now() - n.at.getTime() < 5000);
  const p = await call(10, { action: "pulse" });
  assert.equal(p.payload.unread.total, 1);
  assert.ok(p.payload.unread.latest > Date.now() - 5000);
});
