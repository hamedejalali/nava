/** Defect A/D: expiry cron + countdown must only ever touch the EXACT expired entry they verified. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.CRON_SECRET ||= "cron";
installFakeMongo();
const { processExpiredSearches } = await import("../../api/cron/expire-searches.js");
const Q = await import("../../src/db/models/matchQueue.js");
const S = await import("../../src/features/matching/search.js");

beforeEach(() => resetFakeMongo());

const entry = (id: number, extra: any = {}) => ({
  _id: id, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 100 + id,
  createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 20_000), ...extra,
});

function fakeApi(opts: { sendError?: (to: number) => unknown; onSend?: () => Promise<void> } = {}) {
  const calls: { m: string; a: any[] }[] = [];
  const api: any = {
    deleteMessage: async (...a: any[]) => { calls.push({ m: "deleteMessage", a }); return true; },
    sendMessage: async (...a: any[]) => {
      calls.push({ m: "sendMessage", a });
      if (opts.onSend) await opts.onSend();
      const e = opts.sendError?.(a[0]);
      if (e) throw e;
      return { message_id: 1 };
    },
  };
  return { api, calls };
}
const tgErr = (code: number) => new GrammyError("x", { ok: false, error_code: code, description: "d" } as any, "sendMessage", {});

test("A1. expired entry: user notified exactly once, entry removed", async () => {
  seedUser({ id: 1 });
  await col("match_queue").insertOne(entry(1) as any);
  const { api, calls } = fakeApi();
  const r = await processExpiredSearches(api);
  assert.equal(r.notified, 1);
  assert.equal(calls.filter((c) => c.m === "sendMessage").length, 1);
  assert.equal(col("match_queue").all().length, 0);
});

test("A2. a user who started a NEW search between the cron's read and its delete keeps the new search and gets no timeout notice", async () => {
  seedUser({ id: 1 });
  await col("match_queue").insertOne(entry(1) as any);
  const stale = (await Q.findExpiredUnnotified())[0]!;
  // user starts a fresh search (upsert replaces the document, as upsertQueueEntry does)
  await Q.upsertQueueEntry({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, expiresAt: new Date(Date.now() + 40_000) } as any);
  assert.equal(await Q.leaseExpiredQueueEntry(stale), null, "stale snapshot must not be leased");
  await Q.finishExpiredQueueEntry(stale); // even a blind finish must not delete the new document
  assert.equal(col("match_queue").all().length, 1);
  assert.ok(col("match_queue").byId(1).expiresAt.getTime() > Date.now());
});

test("A3. a new search started while the notice is being sent survives the cron", async () => {
  seedUser({ id: 1 });
  await col("match_queue").insertOne(entry(1) as any);
  const { api } = fakeApi({
    onSend: async () => { await Q.upsertQueueEntry({ _id: 1, searchType: "male", genderSnapshot: "male", ageSnapshot: 25, expiresAt: new Date(Date.now() + 40_000) } as any); },
  });
  await processExpiredSearches(api);
  const left = col("match_queue").all();
  assert.equal(left.length, 1, "the new search must still be queued");
  assert.equal(left[0].searchType, "male");
});

test("A4. two cron runs at the same time never send the notice twice", async () => {
  for (let i = 1; i <= 5; i++) { seedUser({ id: i }); await col("match_queue").insertOne(entry(i) as any); }
  const a = fakeApi(), b = fakeApi();
  const [ra, rb] = await Promise.all([processExpiredSearches(a.api), processExpiredSearches(b.api)]);
  const sent = [...a.calls, ...b.calls].filter((c) => c.m === "sendMessage").map((c) => c.a[0]).sort();
  assert.deepEqual(sent, [1, 2, 3, 4, 5]);
  assert.equal(ra.notified + rb.notified, 5);
  assert.equal(col("match_queue").all().length, 0);
});

test("A5. transient Telegram failure keeps the entry for a retry (nothing lost); one failure does not stop the others", async () => {
  seedUser({ id: 1 }); seedUser({ id: 2 });
  await col("match_queue").insertOne(entry(1) as any);
  await col("match_queue").insertOne(entry(2) as any);
  const first = fakeApi({ sendError: (to) => (to === 1 ? tgErr(429) : null) });
  const r1 = await processExpiredSearches(first.api);
  assert.equal(r1.failed, 1);
  assert.equal(r1.notified, 1);
  assert.deepEqual(col("match_queue").all().map((d: any) => d._id), [1]);
  // lease still active -> not hammered immediately
  assert.equal((await processExpiredSearches(fakeApi().api)).notified, 0);
  // lease expires -> retried and delivered
  await col("match_queue").updateOne({ _id: 1 }, { $set: { timeoutLeaseUntil: new Date(Date.now() - 1) } });
  const retry = fakeApi();
  assert.equal((await processExpiredSearches(retry.api)).notified, 1);
  assert.equal(col("match_queue").all().length, 0);
});

test("A6. permanent Telegram failure (user blocked the bot) still cleans the entry, no endless retries", async () => {
  seedUser({ id: 1 });
  await col("match_queue").insertOne(entry(1) as any);
  const r = await processExpiredSearches(fakeApi({ sendError: () => tgErr(403) }).api);
  assert.equal(r.failed, 0);
  assert.equal(col("match_queue").all().length, 0);
});

test("A7. an entry that is not expired yet is never touched", async () => {
  seedUser({ id: 1 });
  await col("match_queue").insertOne(entry(1, { expiresAt: new Date(Date.now() + 30_000) }) as any);
  const r = await processExpiredSearches(fakeApi().api);
  assert.equal(r.processed, 0);
  assert.equal(col("match_queue").all().length, 1);
});

test("A8. countdown of an OLD search never deletes / times out a newer search by the same user", async () => {
  const u = seedUser({ id: 1, gender: "male", age: 25, province: "تهران", relicBalance: 5 });
  await col("match_queue").insertOne(entry(1, { createdAt: new Date(), expiresAt: new Date(Date.now() + 300) }) as any);
  const { api, calls } = fakeApi();
  const run = S.runCountdown(api as any, u, 1, 101, "fa", "lucky", { totalMs: 300, tickMs: 40 });
  // user cancels and immediately searches again while the first countdown is still running
  setTimeout(async () => {
    await Q.claimQueueEntry(1);
    await Q.upsertQueueEntry({ _id: 1, searchType: "lucky", genderSnapshot: "male", ageSnapshot: 25, expiresAt: new Date(Date.now() + 5_000) } as any);
  }, 100);
  await run;
  assert.equal(col("match_queue").all().length, 1, "the newer search is untouched");
  assert.ok(!calls.some((c) => c.m === "sendMessage"), "no stale timeout notice");
});

test("A9. countdown timeout yields to a cron run that already owns the delivery (no double notice)", async () => {
  const u = seedUser({ id: 1, gender: "male", age: 25, province: "تهران", relicBalance: 5 });
  await col("match_queue").insertOne(entry(1, { createdAt: new Date(), expiresAt: new Date(Date.now() + 200), timeoutLeaseUntil: new Date(Date.now() + 60_000) }) as any);
  const { api, calls } = fakeApi();
  await S.runCountdown(api as any, u, 1, 101, "fa", "lucky", { totalMs: 200, tickMs: 40 });
  assert.ok(!calls.some((c) => c.m === "sendMessage"));
});
