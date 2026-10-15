/** v1.16.3 — webhook failure strategy: transient vs permanent failures, duplicates, concurrency, unavailable inbox. (in-memory Mongo fake) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const W = await import("../../src/webhook/processUpdate.js");
const { GrammyError } = await import("grammy");

beforeEach(() => resetFakeMongo());
const upd = (id: number) => ({ update_id: id, message: { message_id: 1, date: 0, chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false, first_name: "x" }, text: "hi" } }) as any;
const mongoNet = () => Object.assign(new Error("net down"), { name: "MongoNetworkError" });
const origError = console.error;
beforeEach(() => { console.error = () => {}; });
test.after(() => { console.error = origError; });

test("W1. success: handled once, 200, recorded as done", async () => {
  let n = 0;
  const r = await W.processUpdateOnce(upd(1), async () => { n++; });
  assert.deepEqual([r.outcome, r.http, n], ["processed", 200, 1]);
  assert.equal(col("update_inbox").byId(1).state, "done");
});

test("W2. DUPLICATE delivery of a finished update: acknowledged (200) without running the handlers again", async () => {
  let n = 0;
  await W.processUpdateOnce(upd(2), async () => { n++; });
  const r = await W.processUpdateOnce(upd(2), async () => { n++; });
  assert.deepEqual([r.outcome, r.http, n], ["duplicate", 200, 1]);
});

test("W3. TRANSIENT failure (MongoDB network error): 500 so Telegram redelivers; the redelivery then succeeds and is processed", async () => {
  let n = 0;
  const r1 = await W.processUpdateOnce(upd(3), async () => { n++; throw mongoNet(); });
  assert.deepEqual([r1.outcome, r1.http], ["retry", 500]);
  assert.equal(col("update_inbox").byId(3).state, "failed");
  const r2 = await W.processUpdateOnce(upd(3), async () => { n++; });
  assert.deepEqual([r2.outcome, r2.http, n], ["processed", 200, 2]);
  assert.equal(col("update_inbox").byId(3).attempts, 2);
});

test("W4. wrapped errors (grammY BotError.error) are classified by the REAL cause: Telegram 5xx/429 = transient, a bug = permanent", () => {
  const bot = (e: unknown) => Object.assign(new Error("wrapped"), { error: e });
  assert.equal(W.isTransientFailure(bot(new GrammyError("x", { ok: false, error_code: 502, description: "bad gw" } as any, "sendMessage", {}))), true);
  assert.equal(W.isTransientFailure(bot(new GrammyError("x", { ok: false, error_code: 429, description: "slow" } as any, "sendMessage", {}))), true);
  assert.equal(W.isTransientFailure(bot(mongoNet())), true);
  assert.equal(W.isTransientFailure(bot(new GrammyError("x", { ok: false, error_code: 400, description: "bad" } as any, "sendMessage", {}))), false);
  assert.equal(W.isTransientFailure(bot(new TypeError("undefined is not a function"))), false);
});

test("W5. PERMANENT failure (a bug): redelivered only up to the cap, then parked as dead -> 200 (the redelivery loop STOPS) + the user is told once", async () => {
  let n = 0, told = 0;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await W.processUpdateOnce(upd(5), async () => { n++; throw new TypeError("bug"); }, { onDead: async () => { told++; } }));
  assert.deepEqual(results.slice(0, 2).map((r) => r.http), [500, 500]);
  assert.equal(results[2]!.outcome, "dead_letter");
  assert.equal(results[2]!.http, 200);
  assert.equal(n, W.MAX_ATTEMPTS_PERMANENT, "handlers ran exactly the capped number of times");
  assert.equal(results[3]!.outcome, "duplicate", "later redeliveries are acknowledged without work");
  assert.equal(told, 1);
  assert.equal(col("update_inbox").byId(5).state, "dead");
});

test("W6. transient failures get a larger (but still bounded) number of attempts", async () => {
  let n = 0;
  for (let i = 0; i < 15; i++) await W.processUpdateOnce(upd(6), async () => { n++; throw mongoNet(); });
  assert.equal(n, W.MAX_ATTEMPTS_TRANSIENT);
  assert.equal(col("update_inbox").byId(6).state, "dead");
});

test("W7. two CONCURRENT deliveries of the same update: handlers run once; the other is told to come back (5xx), not silently dropped", async () => {
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = W.processUpdateOnce(upd(7), async () => { n++; await gate; });
  await new Promise((r) => setTimeout(r, 10));
  const second = await W.processUpdateOnce(upd(7), async () => { n++; });
  assert.deepEqual([second.outcome, second.http], ["in_progress", 500]);
  release();
  assert.equal((await first).outcome, "processed");
  assert.equal(n, 1);
});

test("W8. a crashed invocation (lease expired) is taken over by the redelivery", async () => {
  await col("update_inbox").insertOne({ _id: 8, state: "processing", attempts: 1, leaseUntil: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date() } as any);
  let n = 0;
  const r = await W.processUpdateOnce(upd(8), async () => { n++; });
  assert.deepEqual([r.outcome, r.http, n], ["processed", 200, 1]);
  assert.equal(col("update_inbox").byId(8).attempts, 2);
});

test("W9. inbox database unavailable: the update is NOT acknowledged (503) and the handlers do not run", async () => {
  let n = 0;
  const broken: any = { insertOne: async () => { throw mongoNet(); } };
  const r = await W.processUpdateOnce(upd(9), async () => { n++; }, { collection: broken });
  assert.deepEqual([r.outcome, r.http, n], ["inbox_unavailable", 503, 0]);
});

test("W10. real bot: the same /start delivered twice (lost 200) produces ONE reply", async () => {
  const { createHarness } = await import("../harness/fakeTelegram.js");
  const h = await createHarness();
  h.resetCalls();
  const u = { update_id: 4242, message: { message_id: 10, date: Math.floor(Date.now() / 1000), chat: { id: 7777, type: "private" }, from: { id: 7777, is_bot: false, first_name: "Z" }, text: "hello there" } } as any;
  const handle = (x: any) => h.bot.handleUpdate(x);
  const r1 = await W.processUpdateOnce(u, handle);
  const sent1 = h.of("sendMessage", 7777).length;
  const r2 = await W.processUpdateOnce(u, handle);
  assert.equal(r1.outcome, "processed"); assert.equal(r2.outcome, "duplicate");
  assert.ok(sent1 > 0);
  assert.equal(h.of("sendMessage", 7777).length, sent1, "no second reply");
});
