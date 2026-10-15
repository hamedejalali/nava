/** Connect flow: the match is committed first, so notifying must never leave a half-connected / stuck pair. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const A = 8001, B = 8002;
const sessions = () => col("chat_sessions").all();
const bal = (id: number) => col("users").byId(id).relicBalance;
let testNo = 0; // interceptors installed by one test must not act in later tests
beforeEach(() => {
  testNo++;
  resetState(); h.resetCalls(); h.clearFailures();
  seedUser({ id: A, nickname: "a", relicBalance: 5, relicInitialized: true, gender: "male" });
  seedUser({ id: B, nickname: "b", relicBalance: 5, relicInitialized: true, gender: "female" });
});

async function search(id: number) {
  await h.callback(id, "partner:lucky").catch(() => {});
}
const lucky = async () => {
  const { PARTNER_TYPE_CALLBACKS } = await import("../../src/features/matching/constants.js");
  return PARTNER_TYPE_CALLBACKS.lucky;
};

test("M1. A searches, B searches 3s later: both are told, session exists, both charged once", async () => {
  const cb = await lucky();
  await h.callback(A, cb);
  assert.equal(col("match_queue").all().length, 1);
  await h.callback(B, cb);
  assert.equal(sessions().length, 1);
  assert.equal(bal(A), 4); assert.equal(bal(B), 4);
  for (const id of [A, B]) assert.ok(h.of("sendMessage", id).some((c) => /وصلتون کردم/.test(String(c.payload.text))), `user ${id} got the connect notice`);
});

test("M2. REGRESSION: if A's notice fails with a non-permanent error, B still gets the notice and the webhook call does not throw", async () => {
  const cb = await lucky();
  await h.callback(A, cb);
  const api = h.bot.api.config as any;
  let failA = 6;
  const mine = testNo;
  api.use(async (prev: any, method: string, payload: any) => {
    if (mine !== testNo) return prev(method, payload);
    if (method === "sendMessage" && payload.chat_id === A && /وصلتون کردم/.test(String(payload.text)) && failA-- > 0) return { ok: false, error_code: 502, description: "Bad Gateway" };
    return prev(method, payload);
  });
  await h.callback(B, cb); // must not reject
  assert.ok(h.of("sendMessage", B).some((c) => /وصلتون کردم/.test(String(c.payload.text))), "B was told even though A's delivery failed");
  assert.equal(sessions().length, 1);
});

test("M3. REGRESSION: a rejected controls keyboard (400) falls back to a plain warning, the match stays", async () => {
  const cb = await lucky();
  await h.callback(A, cb);
  const mine = testNo;
  (h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
    if (mine !== testNo) return prev(method, payload);
    if (method === "sendMessage" && payload.reply_markup?.keyboard && payload.chat_id === B) return { ok: false, error_code: 400, description: "Bad Request: BUTTON_STYLE_INVALID" };
    return prev(method, payload);
  });
  await h.callback(B, cb);
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].active, true);
  assert.ok(h.of("sendMessage", B).some((c) => /اخطار/.test(String(c.payload.text)) && !c.payload.reply_markup), "plain warning delivered");
});

test("M4. REGRESSION: a participant who blocked the bot -> match undone, both refunded, both freed, the other is told", async () => {
  const cb = await lucky();
  await h.callback(A, cb);
  h.failFor("sendMessage", A);
  await h.callback(B, cb);
  h.clearFailures();
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].active, false);
  assert.equal(bal(A), 5); assert.equal(bal(B), 5);
  assert.ok(!col("users").byId(A).activeChatSessionId);
  assert.ok(!col("users").byId(B).activeChatSessionId);
  assert.ok(h.of("sendMessage", B).some((c) => /در دسترس نبود/.test(String(c.payload.text))));
});
