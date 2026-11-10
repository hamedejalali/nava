/** v1.29.8 — fixes for the independent audit of v1.29.7 (A-01 rate limiter, A-02 wallet receipt, A-03 age change in a running chat,
 *  A-04 DM overview concurrency, F-18 Stars user_missing, F-19 registry collisions).
 *  MOCK TESTS: fake MongoDB / Telegram. They prove application logic, NOT real MongoDB transactions, Telegram or Vercel behaviour. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ WALLET_API_URL: "https://wallet.example.com/api/v1/", WALLET_INTEGRATION_ID: "itg_test123", WALLET_API_SECRET: "wsk_supersecret", OWNER_ID: "1", MODERATION_LOG_CHAT_ID: "1", NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const dep = await import("../../src/services/wallet/walletDeposits.js");
const { memoryRateLimit, _resetMemoryRateLimit } = await import("../../src/utils/rateLimit.js");
const { mapLimit } = await import("../../src/utils/mapLimit.js");
const { default: handler, MINIAPP_CALLS_PER_MINUTE } = await import("../../api/miniapp.js");
const { buildRegistry } = await import("../../src/services/games/registry.js");

beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); _resetMemoryRateLimit(); });

/* ------------------------------------------------------------ A-01 */
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

test("V1. memoryRateLimit: counts per person/window, blocks above the ceiling, is bounded", () => {
  const t = 1_000_000;
  for (let i = 1; i <= 5; i++) assert.equal(memoryRateLimit(1, "x", 5, 60_000, t).allowed, true);
  assert.equal(memoryRateLimit(1, "x", 5, 60_000, t).allowed, false);
  assert.equal(memoryRateLimit(2, "x", 5, 60_000, t).allowed, true, "another person is independent");
  assert.equal(memoryRateLimit(1, "x", 5, 60_000, t + 60_000).allowed, true, "next window");
  _resetMemoryRateLimit();
  let refused = 0;
  for (let i = 0; i < 6000; i++) if (!memoryRateLimit(i, "b", 1000, 60_000, t).allowed) refused++;
  assert.ok(refused > 0 && refused <= 1000 + 1, "hard cap on keys: newcomers beyond the cap are refused, memory stays bounded");
});

test("V2. Mini App: when the MongoDB limiter THROWS, the call is neither unlimited nor locked out (in-memory fallback, same ceiling)", async () => {
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", relicBalance: 1 });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", relicBalance: 1 });
  const rl = col("rate_limits") as any;
  const orig = rl.findOneAndUpdate.bind(rl);
  rl.findOneAndUpdate = async () => { throw new Error("rate_limits unavailable"); };
  try {
    const first = await call(1, { action: "me" });
    assert.equal(first.status, 200, "a limiter outage does not lock people out");
    let blocked = 0;
    for (let i = 0; i < MINIAPP_CALLS_PER_MINUTE + 5; i++) if ((await call(1, { action: "me" })).status === 429) blocked++;
    assert.ok(blocked >= 1, "…but it is no longer unlimited");
    assert.equal((await call(2, { action: "me" })).status, 200, "another person is unaffected");
  } finally { rl.findOneAndUpdate = orig; }
});

/* ------------------------------------------------------------ A-02 */
const tx = (id: string, user: number, n: number) => ({ id, source: "wallet", status: "COMPLETED", amount: n, delivered_amount: n, fee: 0, external_user_id: String(user), completed_at: "2026-10-01T00:00:00Z" }) as any;
function tg(opts: { failLog?: () => boolean } = {}) {
  const sent: Array<{ id: number; text: string }> = [];
  return { sent, api: { async sendMessage(id: number, text: string) { if (id === 1 && /رسید واریز/.test(text) && opts.failLog?.()) throw { error_code: 500 }; sent.push({ id, text }); return {} as any; } } as any };
}
const receipts = (s: Array<{ id: number; text: string }>) => s.filter((m) => /رسید واریز/.test(m.text)).length;
const seedDep = () => seedUser({ id: 7, anonId: "user_W0007", nickname: "w", relicBalance: 0, relicInitialized: true } as any);

test("V3. receipt: a failed log-chat send is retried by the next sync and delivered exactly once; the credit is untouched", async () => {
  seedDep();
  let fail = true;
  const { api, sent } = tg({ failLog: () => fail });
  const out = await dep.creditTransfer(tx("R1", 7, 5));
  await dep.announceCredit(api, out as any);
  assert.equal(receipts(sent), 0);
  const row = col("wallet_deposits").byId("R1")!;
  assert.ok(row.notifiedAt, "the user notice itself went out");
  assert.equal(row.logNotifiedAt, undefined, "receipt NOT marked as sent");
  assert.equal(row.logAttempts, 1);
  fail = false;
  assert.equal(await dep.retryPendingAnnouncements(api), 1);
  assert.equal(receipts(sent), 1);
  assert.ok(col("wallet_deposits").byId("R1")!.logNotifiedAt);
  assert.equal(await dep.retryPendingAnnouncements(api), 0, "nothing left");
  assert.equal(receipts(sent), 1, "exactly once");
  assert.equal(col("users").byId(7).relicBalance, 5, "credited once");
});

test("V4. receipt: a crash AFTER the claim but BEFORE the send (lease left behind) is recovered when the lease expires", async () => {
  seedDep();
  const { api, sent } = tg();
  const out = await dep.creditTransfer(tx("R2", 7, 3));
  await col("wallet_deposits").updateOne({ _id: "R2" }, { $set: { notifiedAt: new Date(), logLeaseUntil: new Date(Date.now() + 60_000) } }); // a worker claimed and died
  await dep.announceCredit(api, out as any);
  assert.equal(receipts(sent), 0, "lease still valid: nobody sends a second copy");
  await col("wallet_deposits").updateOne({ _id: "R2" }, { $set: { logLeaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await dep.retryPendingAnnouncements(api), 1);
  assert.equal(receipts(sent), 1);
  assert.ok(col("wallet_deposits").byId("R2")!.logNotifiedAt);
});

test("V5. receipt: after MAX attempts it stops (no endless retry), and rows already marked as sent are never re-sent", async () => {
  seedDep();
  const { api, sent } = tg({ failLog: () => true });
  const out = await dep.creditTransfer(tx("R3", 7, 2));
  await dep.announceCredit(api, out as any);
  for (let i = 0; i < 15; i++) await dep.retryPendingAnnouncements(api);
  assert.equal(col("wallet_deposits").byId("R3")!.logAttempts, 10);
  assert.equal(receipts(sent), 0);
  // an old row (pre-1.29.8) that carries logNotifiedAt is left alone
  await col("wallet_deposits").insertOne({ _id: "OLD", userId: 7, amount: 1, creditedAt: new Date(), notifiedAt: new Date(), logNotifiedAt: new Date() } as any);
  assert.equal(await dep.retryPendingAnnouncements(api), 0);
});

/* ------------------------------------------------------------ A-03 */
const mkU = (id: number, age: number, extra: Record<string, unknown> = {}) => seedUser({ id, anonId: `user_A${id}`, nickname: `N${id}`, age, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 5, relicInitialized: true, onboardingStep: "COMPLETED", ...extra } as never);
const sessionDoc = (over: Record<string, unknown> = {}) => ({ _id: "S1", userA: 11, userB: 12, active: true, messageCount: 2, createdAt: new Date(), ...over });

test("V6. an approved age change that crosses the band ends the running chat for BOTH, frees both, and refunds a short chat once", async () => {
  mkU(11, 25, { activeChatSessionId: "S1" }); mkU(12, 24, { activeChatSessionId: "S1" });
  await col("chat_sessions").insertOne(sessionDoc() as any);
  await col("users").updateOne({ _id: 11 }, { $set: { age: 16 } }); // the approved change
  const { enforceAgeBandOnSession } = await import("../../src/services/ageChangeCleanup.js");
  assert.equal(await enforceAgeBandOnSession(h.bot.api as any, "S1", 11), true);
  const s = col("chat_sessions").byId("S1");
  assert.equal(s.active, false); assert.equal(s.endReason, "age_band");
  assert.equal(col("users").byId(11).activeChatSessionId, null);
  assert.equal(col("users").byId(12).activeChatSessionId, null);
  assert.equal(h.of("sendMessage", 11).length, 1); assert.equal(h.of("sendMessage", 12).length, 1);
  assert.equal(await enforceAgeBandOnSession(h.bot.api as any, "S1", 11), false, "repeat does nothing");
  assert.equal(h.of("sendMessage", 11).length, 1);
  assert.equal(col("users").byId(11).relicBalance, 6, "short chat: refunded once");
  assert.equal(col("users").byId(12).relicBalance, 6);
});

test("V7. same band (or an age moving inside the band) keeps the chat running; a longer chat is closed without refund", async () => {
  mkU(11, 25, { activeChatSessionId: "S1" }); mkU(12, 24, { activeChatSessionId: "S1" });
  await col("chat_sessions").insertOne(sessionDoc() as any);
  const { enforceAgeBandOnSession } = await import("../../src/services/ageChangeCleanup.js");
  await col("users").updateOne({ _id: 11 }, { $set: { age: 40 } });
  assert.equal(await enforceAgeBandOnSession(h.bot.api as any, "S1", 11), false);
  assert.equal(col("chat_sessions").byId("S1").active, true);
  await col("chat_sessions").updateOne({ _id: "S1" }, { $set: { messageCount: 9 } });
  await col("users").updateOne({ _id: 11 }, { $set: { age: 15 } });
  assert.equal(await enforceAgeBandOnSession(h.bot.api as any, "S1", 11), true);
  assert.equal(col("users").byId(11).relicBalance, 5, "long chat: no refund");
});

test("V8. the next relayed message after a band change is NOT delivered and the chat is closed (relay re-check)", async () => {
  mkU(11, 25, { activeChatSessionId: "S1" }); mkU(12, 24, { activeChatSessionId: "S1" });
  await col("chat_sessions").insertOne(sessionDoc() as any);
  await h.text(11, "سلام"); // allowed pair → relayed
  assert.ok(h.of("sendMessage", 12).some((c) => /سلام/.test(String(c.payload.text))), "baseline: the pair can talk");
  h.resetCalls();
  await col("users").updateOne({ _id: 12 }, { $set: { age: 15 } }); // changed behind the cache
  await h.text(11, "پیام دوم");
  assert.equal(h.of("sendMessage", 12).filter((c) => /پیام دوم/.test(String(c.payload.text))).length, 0, "not relayed");
  assert.equal(col("chat_sessions").byId("S1").active, false);
});

test("V9. fail-closed inputs: a partner with no/invalid age cannot keep a running chat (same rule as starting one)", async () => {
  mkU(11, 25, { activeChatSessionId: "S1" }); mkU(12, 24, { activeChatSessionId: "S1" });
  await col("chat_sessions").insertOne(sessionDoc() as any);
  await col("users").updateOne({ _id: 12 }, { $unset: { age: "" } });
  const { enforceAgeBandOnSession } = await import("../../src/services/ageChangeCleanup.js");
  assert.equal(await enforceAgeBandOnSession(h.bot.api as any, "S1", 11), true);
});

/* ------------------------------------------------------------ A-04 */
test("V10. mapLimit keeps the order and never exceeds the concurrency limit", async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 9, 8, 7], 3, async (n) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, n)); live--; return n * 2; });
  assert.deepEqual(out, [10, 2, 8, 4, 6, 18, 16, 14]);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});

test("V11. DM overview: same result as before (last message, unread, order, deleted-thread skipping) with the parallel lookups", async () => {
  mkU(21, 25); mkU(22, 25); mkU(23, 25); mkU(24, 25);
  const now = Date.now();
  const ses = (id: string, a: number, b: number, extra: any = {}) => col("chat_sessions").insertOne({ _id: id, userA: a, userB: b, origin: "miniapp", active: true, createdAt: new Date(now - 1000), dmSeq: 3, readA: 0, readB: 0, ...extra } as any);
  await ses("D1", 21, 22); await ses("D2", 21, 23, { clearA: 3, dmSeq: 3 }); await ses("D3", 24, 21, { readB: 1 });
  const m = (sid: string, seq: number, sender: number, text: string, kind = "text") => col("dm_messages").insertOne({ _id: `${sid}:${seq}`, sessionId: sid, seq, senderId: sender, text, kind, at: new Date(now - 500 + seq) } as any);
  await m("D1", 1, 22, "a"); await m("D1", 2, 22, "b"); await m("D1", 3, 21, "c");
  await m("D3", 1, 24, "x"); await m("D3", 2, 24, "y"); await m("D3", 3, 24, "z");
  const { overview } = await import("../../src/services/nava/dm.js");
  const me = col("users").byId(21);
  const r = await overview(me);
  assert.deepEqual(r.items.map((i: any) => i.sid).sort(), ["D1", "D3"], "D2 (deleted by me, nothing new) is skipped");
  const d1 = r.items.find((i: any) => i.sid === "D1")!, d3 = r.items.find((i: any) => i.sid === "D3")!;
  assert.equal(d1.unread, 2); assert.equal(d1.last?.text, "c"); assert.equal(d1.last?.mine, true);
  assert.equal(d3.unread, 2, "readB=1 → messages 2 and 3 unread"); assert.equal(d3.last?.text, "z");
});

/* ------------------------------------------------------------ F-18 / F-19 */
test("V12. Stars: a payment for a user with NO document credits nothing, rolls back the order claim and the ledger row, and reports user_missing", async () => {
  const { creditStarsPaymentOnce } = await import("../../src/db/models/relic.js");
  await col("stars_orders").insertOne({ _id: "O1", status: "pending", userId: 999, relic: 5, price: 50, createdAt: new Date() } as any);
  const r = await creditStarsPaymentOnce({ orderId: "O1", userId: 999, chargeId: "C1", relic: 5, stars: 50 });
  assert.equal(r, "user_missing");
  assert.equal(col("stars_orders").byId("O1").status, "pending", "order claim rolled back");
  assert.equal(col("ledger").all().filter((x: any) => x._id === "purchase:C1").length, 0, "no ledger row for money that was not added");
});

test("V13. Stars: the normal payment is unchanged (credited once, duplicate is a no-op)", async () => {
  mkU(31, 25, { relicBalance: 1 });
  const { creditStarsPaymentOnce } = await import("../../src/db/models/relic.js");
  await col("stars_orders").insertOne({ _id: "O2", status: "pending", userId: 31, relic: 5, price: 50, createdAt: new Date() } as any);
  assert.equal(await creditStarsPaymentOnce({ orderId: "O2", userId: 31, chargeId: "C2", relic: 5, stars: 50 }), "credited");
  assert.equal(await creditStarsPaymentOnce({ orderId: "O2", userId: 31, chargeId: "C2", relic: 5, stars: 50 }), "duplicate");
  assert.equal(col("users").byId(31).relicBalance, 6);
});

test("V14. game registry: two modules defining the same error code are rejected at start-up (no silent overwrite)", () => {
  const mod = (id: string, errors: Record<string, number>) => ({ id, actions: { [`${id}_a`]: { handler: async () => ({}) } }, errors }) as any;
  assert.doesNotThrow(() => buildRegistry([mod("aa", { x: 400 }), mod("bb", { y: 409 })]));
  assert.throws(() => buildRegistry([mod("aa", { x: 400 }), mod("bb", { x: 409 })]), /duplicate error code "x"/);
});
