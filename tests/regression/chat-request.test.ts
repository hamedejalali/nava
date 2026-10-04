/** Mini App chat requests (v1.9.0): create / accept / decline against the fake DB. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, seedChatSession, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const { createChatRequest, CHAT_REQUEST_HOURLY_LIMIT } = await import("../../src/db/models/chatRequest.js");
const { acceptChatRequest } = await import("../../src/services/chatRequestAccept.js");
const { ensureChatRequestIndexes } = await import("../../src/db/models/chatRequest.js");

beforeEach(async () => {
  resetState();
  h.resetCalls();
  await ensureChatRequestIndexes();
  seedUser({ id: 1, relicBalance: 5, profilePhotoFileId: "PH1" });
  seedUser({ id: 2, relicBalance: 5, profilePhotoFileId: "PH2" });
  seedUser({ id: 3, relicBalance: 5, profilePhotoFileId: "PH3" });
});

async function newRequest(from: number, to: number) {
  const r = await createChatRequest(from, to);
  assert.equal(r.status, "created");
  return (r as any).request as { _id: string };
}

test("accept: one atomic step creates the session, charges both once, points both users at it", async () => {
  const req = await newRequest(1, 2);
  const res = await acceptChatRequest(req._id, 2);
  assert.equal(res.status, "accepted");
  const sessionId = (res as any).sessionId;
  assert.equal(col("users").byId(1).relicBalance, 4);
  assert.equal(col("users").byId(2).relicBalance, 4);
  assert.equal(col("users").byId(1).activeChatSessionId, sessionId);
  assert.equal(col("users").byId(2).activeChatSessionId, sessionId);
  assert.equal(col("chat_sessions").byId(sessionId).active, true);
  assert.equal(col("relic_transactions").byId(`chatcost:${sessionId}:1`).type, "CHAT_COST");
  assert.equal(col("chat_requests").byId(req._id).status, "accepted");
});

test("accept twice (duplicate tap / Telegram retry) charges only once", async () => {
  const req = await newRequest(1, 2);
  const [a, b] = await Promise.all([acceptChatRequest(req._id, 2), acceptChatRequest(req._id, 2)]);
  assert.deepEqual([a.status, b.status].sort(), ["accepted", "not_pending"]);
  assert.equal(col("users").byId(1).relicBalance, 4);
  assert.equal(col("users").byId(2).relicBalance, 4);
  assert.equal(col("chat_sessions").all().length, 1);
});

test("only the addressee can accept; a stranger gets nothing", async () => {
  const req = await newRequest(1, 2);
  assert.equal((await acceptChatRequest(req._id, 3)).status, "not_pending");
  assert.equal((await acceptChatRequest(req._id, 1)).status, "not_pending");
  assert.equal(col("chat_requests").byId(req._id).status, "pending");
});

test("two requests to the same person accepted at the same moment: exactly one chat, the other is 'busy' and fully rolled back", async () => {
  const r1 = await newRequest(1, 2);
  const r3 = await newRequest(3, 2);
  const results = await Promise.all([acceptChatRequest(r1._id, 2), acceptChatRequest(r3._id, 2)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["accepted", "busy"]);
  assert.equal(col("chat_sessions").all().length, 1);
  const loser = results[0]!.status === "busy" ? 0 : 1;
  const loserFrom = loser === 0 ? 1 : 3;
  assert.equal(col("users").byId(loserFrom).relicBalance, 5, "the other requester was not charged");
  assert.ok(!col("users").byId(loserFrom).activeChatSessionId);
  assert.equal(col("chat_requests").byId(loser === 0 ? r1._id : r3._id).status, "pending", "claim rolled back");
});

test("insufficient balance rolls everything back (nobody charged, request still pending)", async () => {
  await col("users").updateOne({ _id: 2 }, { $set: { relicBalance: 0 } });
  const req = await newRequest(1, 2);
  const res = await acceptChatRequest(req._id, 2);
  assert.deepEqual(res, { status: "insufficient", userId: 2 });
  assert.equal(col("users").byId(1).relicBalance, 5);
  assert.ok(!col("users").byId(1).activeChatSessionId && !col("users").byId(2).activeChatSessionId);
  assert.equal(col("chat_sessions").all().length, 0);
  assert.equal(col("chat_requests").byId(req._id).status, "pending");
});

test("banned or already-chatting users cannot be pulled into a chat", async () => {
  seedChatSession({ userA: 1, userB: 3 });
  const req = await newRequest(1, 2);
  assert.equal((await acceptChatRequest(req._id, 2)).status, "busy");
});

test("expired requests cannot be accepted", async () => {
  const req = await newRequest(1, 2);
  await col("chat_requests").updateOne({ _id: req._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await acceptChatRequest(req._id, 2)).status, "not_pending");
  assert.equal(col("chat_requests").byId(req._id).status, "expired");
});

test("blocked pair cannot start a chat", async () => {
  const req = await newRequest(1, 2);
  const { blockUser } = await import("../../src/db/models/blocks.js");
  await blockUser(2, 1);
  assert.equal((await acceptChatRequest(req._id, 2)).status, "blocked");
  assert.equal(col("users").byId(1).relicBalance, 5);
});

test("create: one pending request per pair, hourly cap, fresh one after expiry", async () => {
  const first = await createChatRequest(1, 2);
  assert.equal(first.status, "created");
  assert.equal((await createChatRequest(1, 2)).status, "already_pending");
  const old = (first as any).request;
  await col("chat_requests").updateOne({ _id: old._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal((await createChatRequest(1, 2)).status, "created", "expired one is closed, new one allowed");

  for (let i = 0; i < 30; i++) seedUser({ id: 100 + i });
  let limited = 0;
  for (let i = 0; i < 30; i++) if ((await createChatRequest(1, 100 + i)).status === "rate_limited") limited++;
  assert.ok(limited > 0, `rate limit kicks in after ${CHAT_REQUEST_HOURLY_LIMIT}/hour`);
});

test("bot buttons: accept starts the chat for both, decline notifies the requester; stale taps are harmless", async () => {
  const req = await newRequest(1, 2);
  await h.callback(2, `crq:a:${req._id}`);
  assert.equal(col("chat_requests").byId(req._id).status, "accepted");
  assert.ok(h.of("sendMessage", 1).length >= 1 && h.of("sendMessage", 2).length >= 1, "both get the 'connected' messages");
  const kb = h.of("sendMessage", 1).at(-1)!.payload.reply_markup.keyboard.flat().map((b: any) => b.text).join("|");
  assert.ok(kb.includes("پایان چت"), "chat controls keyboard shown");

  h.resetCalls();
  await h.callback(2, `crq:a:${req._id}`); // duplicate
  assert.equal(h.of("sendMessage", 1).length, 0);

  const second = await newRequest(3, 1); // user 1 is now in a chat
  await h.callback(1, `crq:d:${second._id}`);
  assert.equal(col("chat_requests").byId(second._id).status, "declined");
  assert.equal(h.of("sendMessage", 3).length, 1);
  h.resetCalls();
  await h.callback(1, `crq:d:${second._id}`);
  assert.equal(h.of("sendMessage", 3).length, 0, "second decline tap does nothing");
});
