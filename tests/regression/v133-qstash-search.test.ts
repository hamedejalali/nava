/** v1.33.0 — QStash-driven search: steps are idempotent, stale-safe, and fall back to the in-process countdown. (MOCK Mongo/Telegram/QStash) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const E = await import("../../src/features/matching/engine.js");
const ST = await import("../../src/features/matching/searchSteps.js");
const Q = await import("../../src/services/qstash.js");

const user = (id: number, extra: any = {}) => seedUser({ id, gender: id % 2 ? "male" : "female", age: 25, province: "تهران", relicBalance: 5, ...extra });
beforeEach(() => resetFakeMongo());

function fakeApi() {
  const calls: { m: string; a: any[] }[] = [];
  const api: any = new Proxy({}, { get: (_t, m: string) => async (...a: any[]) => { calls.push({ m, a }); return { message_id: 1 }; } });
  return { api, calls };
}
async function queue(id: number, statusMessageId = 55) {
  const u = user(id);
  await col("match_queue").insertOne({ _id: id, searchType: "lucky", genderSnapshot: u.gender, ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId, createdAt: new Date(), expiresAt: new Date(Date.now() + 40_000) } as any);
  return col("match_queue").byId(id).createdAt.getTime() as number;
}
const payload = (kind: any, userId: number, createdAt: number, extra: any = {}) => ({ kind, userId, createdAt, chatId: userId, statusMessageId: 55, lang: "fa", searchType: "lucky", pressedAt: Date.now(), ...extra });

test("Q1. scheduling: scans + seed + expire, delays measured from the press, in ONE batch", async () => {
  let got: any[] = [];
  await ST.scheduleSearch(async (s) => void (got = s), { userId: 1, createdAt: 1, chatId: 1, statusMessageId: 1, lang: "fa", searchType: "lucky", pressedAt: Date.now() - 1000 });
  const kinds = got.map((g) => g.body.kind);
  assert.deepEqual(kinds, ["scan", "scan", "scan", "seed", "expire"]);
  const exp = got.find((g) => g.body.kind === "expire");
  assert.ok(exp.delaySeconds > 38 && exp.delaySeconds <= 39.2, String(exp.delaySeconds));
  assert.ok(got.find((g) => g.body.kind === "seed").delaySeconds < exp.delaySeconds);
});

test("Q2. expire step: timeout notice sent exactly once, even if QStash delivers the step twice", async () => {
  const at = await queue(1);
  const { api, calls } = fakeApi();
  await ST.runSearchStep(api, payload("expire", 1, at));
  await ST.runSearchStep(api, payload("expire", 1, at));
  assert.equal(calls.filter((c) => c.m === "sendMessage" && c.a[0] === 1).length, 1);
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 55));
  assert.equal(col("match_queue").all().length, 0);
});

test("Q3. stale step: an old search's expire does not kill a NEWER search of the same person", async () => {
  const at = await queue(1);
  await col("match_queue").deleteOne({ _id: 1 });
  const at2 = at + 5000;
  await col("match_queue").insertOne({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 77, createdAt: new Date(at2), expiresAt: new Date(Date.now() + 40_000) } as any);
  const { api, calls } = fakeApi();
  await ST.runSearchStep(api, payload("expire", 1, at));
  assert.equal(col("match_queue").all().length, 1, "newer search untouched");
  assert.equal(calls.filter((c) => c.m === "sendMessage").length, 0);
});

test("Q4. scan step connects two waiting people (and refreshes nothing when matched)", async () => {
  // A waits (queued earlier, nobody to match), B is queued manually without scanning → A's scan finds B
  const atA = await queue(1, 55);
  await queue(2, 66);
  const { api, calls } = fakeApi();
  await ST.runSearchStep(api, payload("scan", 1, atA, { display: 10 }));
  assert.equal(col("chat_sessions").all().length, 1);
  assert.equal(col("match_queue").all().length, 0);
  assert.equal(col("users").byId(1).activeChatSessionId, col("users").byId(2).activeChatSessionId);
  assert.ok(!calls.some((c) => c.m === "editMessageReplyMarkup"));
  // a late expire for either does nothing
  await ST.runSearchStep(api, payload("expire", 1, atA));
  const { dictionary } = await import("../../src/i18n/index.js");
  assert.equal(calls.filter((c) => c.m === "sendMessage" && c.a[1] === dictionary("fa").errors.searchTimedOut).length, 0, "no timeout notice after a match");
});

test("Q5. scan step with nobody around only refreshes the number; a cancelled search is ignored", async () => {
  const at = await queue(1);
  const { api, calls } = fakeApi();
  await ST.runSearchStep(api, payload("scan", 1, at, { display: 20 }));
  assert.ok(calls.some((c) => c.m === "editMessageReplyMarkup" && c.a[0] === 1 && c.a[1] === 55));
  await col("match_queue").deleteOne({ _id: 1 });
  const { api: api2, calls: calls2 } = fakeApi();
  await ST.runSearchStep(api2, payload("scan", 1, at, { display: 30 }));
  assert.equal(calls2.length, 0);
});

test("Q6. startSearchTimer: QStash accepted → no in-process countdown; refused / disabled → falls back", async () => {
  const at = await queue(1);
  void at;
  const u = col("users").byId(1);
  const { api } = fakeApi();
  let fell = 0;
  const run = (enabled: boolean, scheduler: any) => ST.startSearchTimer({ api, user: u, chatId: 1, statusMessageId: 55, lang: "fa", searchType: "lucky", pressedAt: Date.now() - 39_900, enabled, scheduler, fallback: (p) => { fell++; void p; } });
  assert.equal(await run(true, async () => {}), "qstash");
  assert.equal(fell, 0);
  assert.equal(await run(true, async () => { throw new Error("qstash down"); }), "inprocess");
  assert.equal(await run(false, async () => {}), "inprocess");
  assert.equal(fell, 2);
});

test("Q7. entry race (unchanged guarantee): simultaneous searchers still produce exactly one session", async () => {
  const [ra, rb] = await Promise.all([E.attemptMatchOrQueue(user(1), "lucky", undefined), E.attemptMatchOrQueue(user(2), "lucky", undefined)]);
  assert.ok([ra.status, rb.status].includes("matched"));
  assert.equal(col("chat_sessions").all().length, 1);
});

test("Q8. QStash is OFF unless all four settings exist; a bad signature is rejected", async () => {
  assert.equal(Q.qstashEnabled(), false);
  assert.equal(await Q.verifyQStash("x", "{}"), false);
});
