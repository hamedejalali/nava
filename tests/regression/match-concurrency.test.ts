/** v1.16.3 — a person can never be in two active chats, however searches/rescans/duplicate taps interleave. (in-memory Mongo fake) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const E = await import("../../src/features/matching/engine.js");

const user = (id: number, extra: any = {}) => seedUser({ id, gender: id % 2 ? "male" : "female", age: 25, province: "تهران", relicBalance: 5, ...extra });
beforeEach(() => resetFakeMongo());
const active = (id: number) => col("chat_sessions").all().filter((s: any) => s.active && (s.userA === id || s.userB === id));
const queueEntry = (id: number) => ({ _id: id, searchType: "lucky", genderSnapshot: id % 2 ? "male" : "female", ageSnapshot: 25, provinceSnapshot: "تهران", createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 30000) }) as any;

test("X1. a searcher who is ALREADY in a chat is refused: nothing charged, no queue entry left, no second session", async () => {
  user(1); user(2); user(3);
  await col("chat_sessions").insertOne({ _id: "S0", userA: 1, userB: 9, active: true, createdAt: new Date() } as any);
  await col("users").updateOne({ _id: 1 }, { $set: { activeChatSessionId: "S0" } });
  await col("match_queue").insertOne(queueEntry(2));
  const r = await E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined);
  assert.equal(r.status, "busy");
  assert.equal(col("chat_sessions").all().length, 1);
  assert.equal(col("users").byId(1).relicBalance, 5);
  assert.ok(col("match_queue").byId(2), "the other waiting person is untouched");
  assert.equal(col("match_queue").all().filter((q: any) => q._id === 1).length, 0);
});

test("X2. a STALE queue entry of a person who is already in a chat is dropped, never matched into a 2nd chat", async () => {
  user(1); user(2); user(3, { activeChatSessionId: "S0" });
  await col("chat_sessions").insertOne({ _id: "S0", userA: 3, userB: 9, active: true, createdAt: new Date() } as any);
  await col("match_queue").insertOne(queueEntry(3));
  const r = await E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined);
  assert.equal(r.status, "queued", "user 1 simply waits; user 3 was not usable");
  assert.equal(active(3).length, 1);
  assert.equal(col("users").byId(3).relicBalance, 5);
  assert.equal(col("match_queue").all().filter((q: any) => q._id === 3).length, 0, "stale entry removed");
});

test("X3. one waiting person, two newcomers at the same instant: the waiting person gets exactly ONE session", async () => {
  for (let round = 0; round < 20; round++) {
    resetFakeMongo();
    user(1); user(2); user(4);
    await col("match_queue").insertOne(queueEntry(3));
    user(3);
    const rs = await Promise.all([E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined), E.attemptMatchOrQueue(col("users").byId(2), "lucky", undefined)]);
    assert.equal(active(3).length, 1, `round ${round}`);
    assert.equal(col("users").byId(3).relicBalance, 4);
    assert.equal(rs.filter((r) => r.status === "matched").length >= 1, true);
  }
});

test("X4. the SAME person tapping 'find chat' 3 times at once (duplicate taps/updates): at most one session, charged once", async () => {
  for (let round = 0; round < 20; round++) {
    resetFakeMongo();
    user(1); user(2);
    await col("match_queue").insertOne(queueEntry(2));
    await Promise.all([1, 2, 3].map(() => E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined)));
    assert.equal(active(1).length, 1, `round ${round}`);
    assert.equal(active(2).length, 1);
    assert.equal(col("users").byId(1).relicBalance, 4);
    assert.equal(col("users").byId(2).relicBalance, 4);
  }
});

test("X5. 30 people searching/rescanning concurrently: nobody is ever in two active chats, charges equal sessions, queue holds no one who is in a chat", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  ids.forEach((i) => user(i));
  await Promise.all(ids.map((i) => E.attemptMatchOrQueue(col("users").byId(i), "lucky", undefined)));
  for (let pass = 0; pass < 3; pass++) {
    await Promise.all(ids.filter((i) => col("match_queue").byId(i)).map((i) => E.rescanQueued(col("users").byId(i), "lucky")));
  }
  let charged = 0;
  for (const i of ids) {
    assert.ok(active(i).length <= 1, `user ${i} has ${active(i).length} active chats`);
    charged += 5 - col("users").byId(i).relicBalance;
    if (active(i).length) assert.equal(col("users").byId(i).activeChatSessionId, active(i)[0]._id);
    if (col("match_queue").byId(i)) assert.equal(active(i).length, 0, `queued user ${i} is also in a chat`);
  }
  assert.equal(charged, col("chat_sessions").all().length * 2);
  assert.equal(col("match_deliveries").all().length, col("chat_sessions").all().length * 2, "every session has its delivery records");
});

test("X6. a banned person waiting in the queue is not matched", async () => {
  user(1); user(2, { banned: true });
  await col("match_queue").insertOne(queueEntry(2));
  const r = await E.attemptMatchOrQueue(col("users").byId(1), "lucky", undefined);
  assert.equal(r.status, "queued");
  assert.equal(col("chat_sessions").all().length, 0);
});

test("X7. rescanning with nobody waiting opens NO database transaction (cheap poll)", async () => {
  user(1);
  await col("match_queue").insertOne(queueEntry(1));
  const { getFakeMongo } = await import("../harness/fakeMongo.js");
  const before = (getFakeMongo() as any).client?.stats?.transactionsStarted ?? 0;
  for (let i = 0; i < 5; i++) await E.rescanQueued(col("users").byId(1), "lucky");
  const after = (getFakeMongo() as any).client?.stats?.transactionsStarted ?? 0;
  assert.equal(after - before, 0);
});
