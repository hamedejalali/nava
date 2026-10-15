/**
 * v1.16.3 — durable match delivery (outbox) + atomic session close.
 * All tests run against the in-memory MongoDB fake and a recording fake Telegram (MOCKED services — see docs).
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const A = 8101, B = 8102;
const sessions = () => col("chat_sessions").all();
const deliveries = () => col("match_deliveries").all();
const bal = (id: number) => col("users").byId(id).relicBalance;
const ledgerRefunds = () => col("relic_transactions").all().filter((r: any) => r.type === "REFUND");
const FOUND = /وصلتون کردم/;
let testNo = 0;
type Rule = (method: string, payload: any) => { error_code: number; description: string; parameters?: any } | undefined;
let rule: Rule | null = null;
h.bot.api.config.use(async (prev: any, method: string, payload: any) => {
  const r = rule?.(method, payload);
  if (r) return { ok: false, ...r } as any;
  return prev(method, payload);
});
const BLOCKED = { error_code: 403, description: "Forbidden: bot was blocked by the user" };
const hasKeyboard = (p: any) => !!p?.reply_markup?.keyboard;
const styled = (p: any) => hasKeyboard(p) && p.reply_markup.keyboard.flat().some((b: any) => b.style || b.icon_custom_emoji_id);

beforeEach(() => {
  testNo++;
  rule = null;
  resetState(); h.resetCalls(); h.clearFailures();
  seedUser({ id: A, nickname: "a", relicBalance: 5, relicInitialized: true, gender: "male" });
  seedUser({ id: B, nickname: "b", relicBalance: 5, relicInitialized: true, gender: "female" });
});

async function lucky() {
  return (await import("../../src/features/matching/constants.js")).PARTNER_TYPE_CALLBACKS.lucky;
}
/** A searches (is queued), THEN `afterA` may install a failure rule, THEN B searches and the match happens. */
async function connect(afterA?: () => void) {
  const cb = await lucky();
  await h.callback(A, cb);
  afterA?.();
  await h.callback(B, cb);
}
const dueNow = async () => { await col("match_deliveries").updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }); };
const D = () => import("../../src/features/matching/matchDelivery.js");

test("O1. normal success: delivery records are written with the match and end 'delivered'; both got notice + styled controls", async () => {
  await connect();
  assert.equal(sessions().length, 1);
  assert.equal(deliveries().length, 2);
  assert.deepEqual(deliveries().map((d: any) => d.state), ["delivered", "delivered"]);
  for (const id of [A, B]) {
    assert.ok(h.of("sendMessage", id).some((c) => FOUND.test(String(c.payload.text))));
    assert.ok(h.of("sendMessage", id).some((c) => styled(c.payload)), `user ${id} got the styled controls`);
  }
  assert.equal(bal(A), 4); assert.equal(bal(B), 4);
});

test("O2. styled keyboard rejected (400) -> SIMPLE keyboard is delivered, state 'degraded', chat untouched", async () => {
  rule = (m, p) => (m === "sendMessage" && styled(p) ? { error_code: 400, description: "Bad Request: BUTTON_STYLE_INVALID" } : undefined);
  await connect();
  assert.equal(sessions()[0].active, true);
  const simple = h.of("sendMessage", B).find((c) => hasKeyboard(c.payload) && !styled(c.payload));
  assert.ok(simple, "simple (unstyled) keyboard delivered");
  assert.deepEqual(deliveries().map((d: any) => d.state), ["degraded", "degraded"]);
  assert.equal(bal(A), 4);
});

test("O3. every keyboard rejected -> plain text with /end; the person can still leave with /end (not trapped)", async () => {
  rule = (m, p) => (m === "sendMessage" && hasKeyboard(p) ? { error_code: 400, description: "Bad Request: keyboard invalid" } : undefined);
  await connect();
  assert.equal(sessions()[0].active, true);
  const plain = h.of("sendMessage", A).find((c) => /\/end/.test(String(c.payload.text)));
  assert.ok(plain && !plain.payload.reply_markup, "plain text carrying the /end hint");
  rule = null;
  h.resetCalls();
  await h.text(A, "/end");
  const confirmMsg = h.of("sendMessage", A).find((c) => c.payload.reply_markup?.inline_keyboard);
  assert.ok(confirmMsg, "the end-chat confirmation (inline buttons) was shown");
  const confirmData = confirmMsg!.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  const { CHAT_CALLBACKS } = await import("../../src/features/matching/constants.js");
  assert.ok(confirmData.includes(CHAT_CALLBACKS.endChatConfirm));
  await h.callback(A, CHAT_CALLBACKS.endChatConfirm);
  assert.equal(sessions()[0].active, false, "the person left the chat although no keyboard was ever delivered");
  assert.ok(!col("users").byId(A).activeChatSessionId);
});

test("O4. transient failure on the LAST message: record stays pending, chat/money untouched; retry sends only what is missing", async () => {
  let failing = true;
  rule = (m, p) => (failing && m === "sendMessage" && p.chat_id === A && hasKeyboard(p) ? { error_code: 502, description: "Bad Gateway" } : undefined);
  await connect();
  const d = col("match_deliveries").byId(`${sessions()[0]._id}:${A}`);
  assert.equal(d.state, "pending");
  assert.equal(d.foundSent, true);
  assert.ok(d.attempts >= 1 && d.nextAttemptAt > new Date(), "backoff scheduled");
  assert.equal(sessions().length, 1); assert.equal(sessions()[0].active, true);
  assert.equal(bal(A), 4);
  // not due yet -> nothing happens
  const { processDueDeliveries } = await D();
  assert.equal((await processDueDeliveries(h.bot.api)).processed, 0);
  failing = false;
  await dueNow();
  assert.equal((await processDueDeliveries(h.bot.api)).processed, 1);
  assert.equal(col("match_deliveries").byId(`${sessions()[0]._id}:${A}`).state, "delivered");
  assert.equal(h.of("sendMessage", A).filter((c) => FOUND.test(String(c.payload.text))).length, 1, "'found' line was NOT sent a second time");
  assert.equal(sessions().length, 1);
  assert.equal(bal(A), 4); assert.equal(bal(B), 4);
});

test("O5. one person blocked the bot (403): session closed atomically, BOTH refunded exactly once, both freed, the other is told", async () => {
  await connect(() => { rule = (m, p) => (m === "sendMessage" && p.chat_id === A ? BLOCKED : undefined); });
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].active, false);
  assert.equal(sessions()[0].endReason, "undelivered");
  assert.equal(bal(A), 5); assert.equal(bal(B), 5);
  assert.equal(ledgerRefunds().length, 2);
  assert.ok(!col("users").byId(A).activeChatSessionId); assert.ok(!col("users").byId(B).activeChatSessionId);
  assert.ok(h.of("sendMessage", B).some((c) => /در دسترس نبود/.test(String(c.payload.text))));
  const states = Object.fromEntries(deliveries().map((d: any) => [d.userId, d.state]));
  assert.equal(states[A], "unreachable");
  assert.ok(["void", "delivered"].includes(states[B]));
  // running the retry pass again changes nothing
  const { processDueDeliveries } = await D();
  await dueNow();
  await processDueDeliveries(h.bot.api);
  assert.equal(bal(A), 5); assert.equal(bal(B), 5); assert.equal(ledgerRefunds().length, 2);
});

test("O6. one reachable, one only transiently failing: reachable person is connected, chat stays open, bounded retries end in 'gave_up' (no refund, no second session)", async () => {
  await connect(() => { rule = (m, p) => (m === "sendMessage" && p.chat_id === A ? { error_code: 500, description: "Internal Server Error" } : undefined); });
  const id = `${sessions()[0]._id}:${A}`;
  const { processDueDeliveries } = await D();
  for (let i = 0; i < 12; i++) {
    await col("match_deliveries").updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: new Date(0) } });
    await processDueDeliveries(h.bot.api);
  }
  const d = col("match_deliveries").byId(id);
  assert.equal(d.state, "gave_up");
  assert.equal(d.attempts, 8, "bounded: exactly MAX attempts");
  assert.equal(col("match_deliveries").byId(`${sessions()[0]._id}:${B}`).state, "delivered");
  assert.equal(sessions().length, 1); assert.equal(sessions()[0].active, true);
  assert.equal(bal(A), 4); assert.equal(bal(B), 4);
});

test("O7. Telegram rate limit (429 with long retry_after) is TRANSIENT: retried later, nobody refunded, chat stays", async () => {
  let limited = true;
  rule = (m, p) => (limited && m === "sendMessage" && p.chat_id === B ? { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 600 } } : undefined);
  await connect();
  assert.equal(col("match_deliveries").byId(`${sessions()[0]._id}:${B}`).state, "pending");
  assert.equal(sessions()[0].active, true);
  limited = false;
  await dueNow();
  const { processDueDeliveries } = await D();
  await processDueDeliveries(h.bot.api);
  assert.equal(col("match_deliveries").byId(`${sessions()[0]._id}:${B}`).state, "delivered");
  assert.equal(ledgerRefunds().length, 0);
});

test("O8. concurrent retry passes: the MongoDB lease lets exactly ONE of them send; nothing is delivered twice", async () => {
  let failing = true;
  await connect(() => { rule = (m, p) => (failing && m === "sendMessage" && p.chat_id === A ? { error_code: 500, description: "boom" } : undefined); });
  failing = false;
  await dueNow();
  h.resetCalls();
  const { processDueDeliveries } = await D();
  await Promise.all([processDueDeliveries(h.bot.api), processDueDeliveries(h.bot.api), processDueDeliveries(h.bot.api)]);
  assert.equal(h.of("sendMessage", A).filter((c) => styled(c.payload)).length, 1, "controls sent exactly once");
  assert.equal(col("match_deliveries").byId(`${sessions()[0]._id}:${A}`).state, "delivered");
});

test("O9. a chat that was ended before the retry ran is 'void' — no message is sent into a finished chat", async () => {
  let failing = true;
  await connect(() => { rule = (m, p) => (failing && m === "sendMessage" && p.chat_id === A ? { error_code: 500, description: "boom" } : undefined); });
  const sid = sessions()[0]._id;
  const { closeSessionAtomic } = await import("../../src/db/models/sessionClose.js");
  await closeSessionAtomic(sid, B, () => [], "user_end");
  failing = false;
  h.resetCalls();
  await dueNow();
  const { processDueDeliveries } = await D();
  await processDueDeliveries(h.bot.api);
  assert.equal(col("match_deliveries").byId(`${sid}:${A}`).state, "void");
  assert.equal(h.of("sendMessage", A).length, 0);
});

test("O10. chat-request accept uses the same durable path (request text, records written with the session)", async () => {
  const { acceptChatRequest } = await import("../../src/services/chatRequestAccept.js");
  await col("chat_requests").insertOne({ _id: "tok123456", fromId: A, toId: B, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } as any);
  const r = await acceptChatRequest("tok123456", B);
  assert.equal(r.status, "accepted");
  assert.equal(deliveries().length, 2);
  assert.ok(deliveries().every((d: any) => d.kind === "request" && d.state === "pending"));
  const { deliverSession, CHAT_REQUEST_ACCEPTED_TEXT } = await D();
  await deliverSession(h.bot.api, (r as any).sessionId, [A, B]);
  for (const id of [A, B]) assert.ok(h.of("sendMessage", id).some((c) => c.payload.text === CHAT_REQUEST_ACCEPTED_TEXT));
  assert.deepEqual(deliveries().map((d: any) => d.state), ["delivered", "delivered"]);
});

// ---------------------------------------------------------------------------------------------------------
// closeSessionAtomic: atomicity / idempotency / concurrency of "end session + free users + refunds"
// ---------------------------------------------------------------------------------------------------------
test("C1. failure in the middle of closing rolls EVERYTHING back (session still active, users still linked, no refund); a retry then completes", async () => {
  await connect();
  const sid = sessions()[0]._id;
  const { closeSessionAtomic } = await import("../../src/db/models/sessionClose.js");
  await assert.rejects(() => closeSessionAtomic(sid, A, () => { throw new Error("db failure mid-way"); }), /db failure mid-way/);
  assert.equal(col("chat_sessions").byId(sid).active, true);
  assert.equal(col("users").byId(A).activeChatSessionId, sid);
  assert.equal(col("users").byId(B).activeChatSessionId, sid);
  assert.equal(ledgerRefunds().length, 0);
  assert.equal(bal(A), 4);
  const ok = await closeSessionAtomic(sid, A, (s) => [s.userA, s.userB], "undelivered");
  assert.equal(ok.status, "ended");
  assert.equal(bal(A), 5); assert.equal(bal(B), 5);
  const again = await closeSessionAtomic(sid, A, (s) => [s.userA, s.userB], "undelivered");
  assert.equal(again.status, "already_ended");
  assert.equal(bal(A), 5); assert.equal(bal(B), 5); assert.equal(ledgerRefunds().length, 2);
});

test("C2. concurrent closes (3 at once): refunds applied exactly once", async () => {
  await connect();
  const sid = sessions()[0]._id;
  const { closeSessionAtomic } = await import("../../src/db/models/sessionClose.js");
  const rs = await Promise.all([1, 2, 3].map(() => closeSessionAtomic(sid, A, (s) => [s.userA, s.userB], "undelivered")));
  assert.equal(rs.filter((r) => r.status === "ended").length, 1);
  assert.equal(bal(A), 5); assert.equal(bal(B), 5); assert.equal(ledgerRefunds().length, 2);
});

test("C3. a refund whose ledger row already exists (earlier crash / legacy path) is never paid twice", async () => {
  await connect();
  const sid = sessions()[0]._id;
  await col("relic_transactions").insertOne({ _id: `refund:${sid}:${A}`, userId: A, amount: 1, type: "REFUND", createdAt: new Date() } as any);
  const { closeSessionAtomic } = await import("../../src/db/models/sessionClose.js");
  const r = await closeSessionAtomic(sid, A, (s) => [s.userA, s.userB], "undelivered");
  assert.equal(r.status, "ended");
  assert.equal(bal(A), 4, "A's refund was already recorded, so no second credit");
  assert.equal(bal(B), 5);
});

test("C4. a short chat ended by one side refunds ONLY the partner (same rule as the UI), a long one refunds nobody", async () => {
  await connect();
  const sid = sessions()[0]._id;
  const { closeSessionAtomic } = await import("../../src/db/models/sessionClose.js");
  // B ends the chat; partner = A, messageCount 0 (< 4) -> only A is refunded
  const r = await closeSessionAtomic(sid, B, (s) => ((s.messageCount ?? 0) < 4 ? [s.userA === B ? s.userB : s.userA] : []), "user_end");
  assert.equal(r.status, "ended");
  assert.deepEqual((r as any).refunded, [A]);
  assert.equal(bal(A), 5); assert.equal(bal(B), 4);

  await resetAndSeed();
  await connect();
  const sid2 = sessions()[0]._id;
  await col("chat_sessions").updateOne({ _id: sid2 }, { $set: { messageCount: 9 } });
  const r2 = await closeSessionAtomic(sid2, B, (s) => ((s.messageCount ?? 0) < 4 ? [A] : []), "user_end");
  assert.deepEqual((r2 as any).refunded, []);
  assert.equal(bal(A), 4); assert.equal(bal(B), 4);
});

async function resetAndSeed() {
  resetState(); h.resetCalls();
  seedUser({ id: A, nickname: "a", relicBalance: 5, relicInitialized: true, gender: "male" });
  seedUser({ id: B, nickname: "b", relicBalance: 5, relicInitialized: true, gender: "female" });
}
