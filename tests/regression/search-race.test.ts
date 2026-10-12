/** Anonymous-chat search: simultaneous searchers, broken candidates, countdown/timeout correctness. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const E = await import("../../src/features/matching/engine.js");
const S = await import("../../src/features/matching/search.js");
const Q = await import("../../src/db/models/matchQueue.js");

const user = (id: number, extra: any = {}) => seedUser({ id, gender: id % 2 ? "male" : "female", age: 25, province: "تهران", relicBalance: 5, ...extra });
beforeEach(() => resetFakeMongo());

const sessionsOf = (id: number) => col("chat_sessions").all().filter((s: any) => s.userA === id || s.userB === id);

test("two users searching at the SAME instant always end up matched with each other (exactly one session)", async () => {
  for (let round = 0; round < 25; round++) {
    resetFakeMongo();
    const a = user(1), b = user(2);
    const [ra, rb] = await Promise.all([E.attemptMatchOrQueue(a, "lucky", undefined), E.attemptMatchOrQueue(b, "lucky", undefined)]);
    const kinds = [ra.status, rb.status].sort();
    assert.ok(kinds.includes("matched"), `round ${round}: ${kinds}`);
    assert.equal(col("chat_sessions").all().length, 1, `round ${round}`);
    assert.equal(col("match_queue").all().length, 0);
    assert.equal(col("users").byId(1).activeChatSessionId, col("users").byId(2).activeChatSessionId);
    assert.equal(col("users").byId(1).relicBalance, 4);
    assert.equal(col("users").byId(2).relicBalance, 4);
  }
});

test("many simultaneous searchers: everyone is matched at most once, pairs are formed, nobody is charged twice", async () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const us = ids.map((i) => user(i));
  await Promise.all(us.map((u) => E.attemptMatchOrQueue(u, "lucky", undefined)));
  const sessions = col("chat_sessions").all();
  assert.equal(sessions.length, 4);
  for (const id of ids) {
    assert.equal(sessionsOf(id).length, 1, `user ${id}`);
    assert.equal(col("users").byId(id).relicBalance, 4);
  }
  assert.equal(col("match_queue").all().length, 0);
});

test("a waiting user who can no longer pay does not block newcomers from matching others", async () => {
  user(1); user(2, { relicBalance: 0 }); user(3);
  await col("match_queue").insertOne({ _id: 2, searchType: "lucky", genderSnapshot: "female", ageSnapshot: 25, provinceSnapshot: "تهران", createdAt: new Date(Date.now() - 5000), expiresAt: new Date(Date.now() + 30000) } as any);
  await col("match_queue").insertOne({ _id: 3, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", createdAt: new Date(), expiresAt: new Date(Date.now() + 30000) } as any);
  const r = await E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined);
  assert.equal(r.status, "matched");
  assert.equal((r as any).partnerId, 3);
  assert.equal(col("match_queue").all().length, 0, "the broken entry was dropped");
  assert.equal(col("users").byId(2).relicBalance, 0);
});

test("claimQueueEntry is exclusive: cancel vs timeout vs match cannot all win", async () => {
  await col("match_queue").insertOne({ _id: 9, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, createdAt: new Date(), expiresAt: new Date(Date.now() - 1) } as any);
  const rs = await Promise.all([Q.claimQueueEntry(9), Q.claimQueueEntry(9), Q.claimQueueEntry(9)]);
  assert.equal(rs.filter(Boolean).length, 1);
});

function fakeApi() {
  const calls: { m: string; a: any[] }[] = [];
  const api: any = new Proxy({}, { get: (_t, m: string) => async (...a: any[]) => { calls.push({ m, a }); return { message_id: 1 }; } });
  return { api, calls };
}

test("countdown: the timeout message is ALWAYS sent at the deadline (even when the entry's TTL moment has passed) and the status message is removed", async () => {
  const u = user(1);
  await col("match_queue").insertOne({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 55, createdAt: new Date(), expiresAt: new Date(Date.now() + 200) } as any);
  const { api, calls } = fakeApi();
  const t0 = Date.now();
  await S.runCountdown(api, u, 1, 55, "fa", "lucky", { totalMs: 400, tickMs: 50 });
  const took = Date.now() - t0;
  assert.ok(took >= 380 && took < 900, `took ${took}ms`);
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 55));
  assert.ok(calls.some((c) => c.m === "sendMessage" && c.a[0] === 1), "timeout notice sent");
  assert.equal(col("match_queue").all().length, 0);
  assert.ok(calls.filter((c) => c.m === "editMessageReplyMarkup").length >= 1, "counter was refreshed");
});

test("countdown: total time is bounded by the deadline even if every Telegram call is slow (no more stuck at 30s)", async () => {
  const u = user(1);
  await col("match_queue").insertOne({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "tehran", createdAt: new Date(), expiresAt: new Date(Date.now() + 500) } as any);
  const slow: any = new Proxy({}, { get: () => async () => { await new Promise((r) => setTimeout(r, 60)); return { message_id: 1 }; } });
  const t0 = Date.now();
  await S.runCountdown(slow, u, 1, 55, "fa", "lucky", { totalMs: 500, tickMs: 50 });
  assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`);
  assert.equal(col("match_queue").all().length, 0);
});

test("countdown: if the user was matched meanwhile, no timeout message is sent", async () => {
  const u = user(1);
  await col("match_queue").insertOne({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", createdAt: new Date(), expiresAt: new Date(Date.now() + 1000) } as any);
  const { api, calls } = fakeApi();
  const run = S.runCountdown(api, u, 1, 55, "fa", "lucky", { totalMs: 400, tickMs: 50 });
  setTimeout(() => void Q.claimQueueEntry(1), 120); // a matcher took the entry
  await run;
  assert.ok(!calls.some((c) => c.m === "sendMessage"), "no timeout/notice after a match");
});

test("countdown re-scan: two people who queued 'simultaneously' still meet while counting down", async () => {
  const a = user(1), b = user(2);
  const mk = (id: number, g: string) => col("match_queue").insertOne({ _id: id, searchType: "lucky", genderSnapshot: g, ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 100 + id, createdAt: new Date(), expiresAt: new Date(Date.now() + 1000) } as any);
  await mk(1, "male"); await mk(2, "female"); // both enqueued, neither saw the other
  const { api, calls } = fakeApi();
  await S.runCountdown(api, a, 1, 101, "fa", "lucky", { totalMs: 600, tickMs: 50 });
  assert.equal(col("chat_sessions").all().length, 1);
  assert.equal(col("match_queue").all().length, 0);
  const notified = calls.filter((c) => c.m === "sendMessage").map((c) => c.a[0]).sort();
  assert.deepEqual([...new Set(notified)], [1, 2], "both users got the 'partner found' message");
  void b;
});
