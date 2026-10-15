/** v1.16.3 — durable search-timeout notices: survive queue-doc TTL deletion, exactly-once, never touch a newer search. (in-memory Mongo fake) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.CRON_SECRET ||= "cron";
installFakeMongo();
const E = await import("../../src/features/matching/engine.js");
const S = await import("../../src/features/matching/search.js");
const N = await import("../../src/features/matching/searchNotices.js");
const M = await import("../../src/db/models/searchNotice.js");
const Q = await import("../../src/db/models/matchQueue.js");
const { processExpiredSearches } = await import("../../api/cron/expire-searches.js");

const user = (id: number, extra: any = {}) => seedUser({ id, gender: id % 2 ? "male" : "female", age: 25, province: "تهران", relicBalance: 5, ...extra });
beforeEach(() => resetFakeMongo());
const tgErr = (code: number) => new GrammyError("x", { ok: false, error_code: code, description: "d" } as any, "sendMessage", {});
function fakeApi(err?: (to: number) => unknown) {
  const calls: { m: string; a: any[] }[] = [];
  const api: any = {
    deleteMessage: async (...a: any[]) => { calls.push({ m: "deleteMessage", a }); return true; },
    sendMessage: async (...a: any[]) => { calls.push({ m: "sendMessage", a }); const e = err?.(a[0]); if (e) throw e; return { message_id: 1 }; },
  };
  return { api, calls, sends: () => calls.filter((c) => c.m === "sendMessage") };
}
const notices = () => col("search_notices").all();
/** a search that started long ago and whose queue document was already removed by MongoDB's TTL sweep */
async function expiredAndTtlDeleted(id: number, ageMs = 120_000) {
  const createdAt = new Date(Date.now() - ageMs);
  await M.armSearchNotice(id, createdAt, new Date(createdAt.getTime() + 40_000), 77);
  return createdAt;
}

test("N1. starting a search arms a durable notice with the search's own creation time", async () => {
  const u = user(1);
  const r = await E.attemptMatchOrQueue(u, "lucky", undefined);
  assert.equal(r.status, "queued");
  assert.equal(notices().length, 1);
  const q = col("match_queue").byId(1);
  assert.equal(notices()[0]._id, `1:${q.createdAt.getTime()}`);
  assert.equal(notices()[0].state, "armed");
});

test("N2. matching voids both searchers' notices (nobody is told 'timed out' after being connected)", async () => {
  const a = user(1), b = user(2);
  await E.attemptMatchOrQueue(a, "lucky", undefined);
  const r = await E.attemptMatchOrQueue(b, "lucky", undefined);
  assert.equal(r.status, "matched");
  assert.ok(notices().every((n: any) => n.state === "void"));
  const { api, sends } = fakeApi();
  await N.processSearchNotices(api);
  assert.equal(sends().length, 0);
});

test("N3. cancelling voids the notice", async () => {
  await E.attemptMatchOrQueue(user(1), "lucky", undefined);
  await Q.claimQueueEntry(1);
  assert.equal(notices()[0].state, "void");
});

test("N4. LOST NOTIFICATION FIX: the queue document was already deleted by TTL -> the recovery pass still tells the user, exactly once", async () => {
  user(1);
  await expiredAndTtlDeleted(1);
  assert.equal(col("match_queue").all().length, 0);
  const { api, sends, calls } = fakeApi();
  const r1 = await N.processSearchNotices(api);
  assert.equal(r1.sent, 1);
  assert.equal(sends().length, 1);
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 77), "status message removed");
  const r2 = await N.processSearchNotices(api);
  assert.equal(r2.processed, 0);
  assert.equal(sends().length, 1, "repeated cleanup runs never notify twice");
  assert.equal(notices()[0].state, "sent");
});

test("N5. concurrent recovery passes (cron + webhook + another instance): exactly one notice", async () => {
  user(1);
  await expiredAndTtlDeleted(1);
  const { api, sends } = fakeApi();
  await Promise.all([N.processSearchNotices(api), N.processSearchNotices(api), N.processSearchNotices(api)]);
  assert.equal(sends().length, 1);
});

test("N6. a NEWER search is never removed or announced as timed out by an older notice", async () => {
  const u = user(1);
  await expiredAndTtlDeleted(1); // old search, queue doc gone
  const r = await E.attemptMatchOrQueue(u, "lucky", undefined); // user starts a new search
  assert.equal(r.status, "queued");
  const fresh = col("match_queue").byId(1);
  const { api, sends } = fakeApi();
  await N.processSearchNotices(api);
  assert.equal(sends().length, 0, "old notice was voided by the newer search, new one is not due yet");
  const still = col("match_queue").byId(1);
  assert.ok(still && still.createdAt.getTime() === fresh.createdAt.getTime(), "new queue entry untouched");
  assert.equal(notices().filter((n: any) => n.state === "armed").length, 1);
});

test("N7. an OLD notice whose queue entry is still there (same search) removes exactly that entry", async () => {
  user(1);
  const createdAt = new Date(Date.now() - 90_000);
  await col("match_queue").insertOne({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, createdAt, expiresAt: new Date(createdAt.getTime() + 40_000), statusMessageId: 9 } as any);
  await M.armSearchNotice(1, createdAt, new Date(createdAt.getTime() + 40_000), 9);
  const { api, sends } = fakeApi();
  await N.processSearchNotices(api);
  assert.equal(sends().length, 1);
  assert.equal(col("match_queue").all().length, 0);
});

test("N8. a person who is already in a chat is not told their search timed out", async () => {
  user(1, { activeChatSessionId: "S1" });
  await expiredAndTtlDeleted(1);
  const { api, sends } = fakeApi();
  await N.processSearchNotices(api);
  assert.equal(sends().length, 0);
  assert.equal(notices()[0].state, "void");
});

test("N9. transient Telegram failure -> retried later, bounded (gave_up after MAX attempts); blocked bot -> terminal, no retries", async () => {
  user(1); user(2);
  await expiredAndTtlDeleted(1);
  const flaky = fakeApi(() => tgErr(502));
  for (let i = 0; i < 10; i++) {
    await col("search_notices").updateMany({}, { $set: { dueAt: new Date(0), leaseUntil: new Date(0) } });
    await N.processSearchNotices(flaky.api);
  }
  assert.equal(flaky.sends().length, M.MAX_NOTICE_ATTEMPTS);
  assert.equal(notices()[0].state, "gave_up");

  await expiredAndTtlDeleted(2);
  const blocked = fakeApi(() => tgErr(403));
  await N.processSearchNotices(blocked.api);
  await N.processSearchNotices(blocked.api);
  assert.equal(blocked.sends().length, 1);
  assert.equal(notices().find((n: any) => n.userId === 2).state, "sent");
});

test("N10. live countdown at the deadline delivers via the notice record; a later recovery pass sends nothing more", async () => {
  const u = user(1);
  await E.attemptMatchOrQueue(u, "lucky", 55);
  const q = col("match_queue").byId(1);
  const { api, sends } = fakeApi();
  await S.runCountdown(api, u, 1, 55, "fa", "lucky", { totalMs: 300, tickMs: 50 });
  assert.equal(sends().length, 1);
  assert.equal(notices()[0].state, "sent");
  await col("search_notices").updateMany({}, { $set: { dueAt: new Date(0) } });
  await N.processSearchNotices(api);
  assert.equal(sends().length, 1);
  void q;
});

test("N11. recovery pass first, then countdown: the countdown stays silent (no duplicate)", async () => {
  const u = user(1);
  await E.attemptMatchOrQueue(u, "lucky", 55);
  await col("search_notices").updateMany({}, { $set: { dueAt: new Date(0) } });
  const { api, sends } = fakeApi();
  await N.processSearchNotices(api);
  assert.equal(sends().length, 1);
  await S.runCountdown(api, u, 1, 55, "fa", "lucky", { totalMs: 200, tickMs: 50 });
  assert.equal(sends().length, 1);
});

test("N12. legacy cron sweep skips searches owned by a notice (no double notification between the two paths)", async () => {
  const u = user(1);
  await E.attemptMatchOrQueue(u, "lucky", 55);
  await col("match_queue").updateOne({ _id: 1 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const { api, sends } = fakeApi();
  const r = await processExpiredSearches(api);
  assert.equal(r.notified, 0);
  assert.equal(sends().length, 0);
  await col("search_notices").updateMany({}, { $set: { dueAt: new Date(0) } });
  await N.processSearchNotices(api);
  assert.equal(sends().length, 1);
});
