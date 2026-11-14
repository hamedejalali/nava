/** v1.28.0 — broadcast lease / compare-and-set (mocked Mongo; a hand-made Api) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

await createHarness({});
const bp = await import("../../src/services/broadcastProcessor.js");
const M = await import("../../src/db/models/broadcast.js");
bp.BROADCAST_PACE.ms = 0;

function fakeApi(fail: (id: number) => any = () => null) {
  const sent: number[] = [];
  const logs: number[] = [];
  const api: any = { async sendMessage(id: number) { const f = fail(id); if (f) throw f; await new Promise((r) => setImmediate(r)); if (id >= 1000) sent.push(id); else logs.push(id); return {}; } };
  return { api, sent, logs };
}
beforeEach(() => {
  resetState();
  for (let i = 1; i <= 100; i++) seedUser({ id: 1000 + i, anonId: `user_B${String(i).padStart(5, "0")}`, nickname: "n" + i, onboardingStep: "COMPLETED" } as any);
});

test("L1. two workers at once: every user gets the message exactly once", async () => {
  const job = await M.createBroadcastJob("hello", 1);
  const { api, sent, logs } = fakeApi();
  await Promise.all([bp.processBroadcastBatch(api, job), bp.processBroadcastBatch(api, job), bp.processBroadcastBatch(api, job)]);
  assert.equal(sent.length, new Set(sent).size, "no user twice");
  assert.equal(sent.length, 100);
  assert.equal(logs.length, 1, "exactly ONE final log message, even with three workers");
  const j = await M.getBroadcastJob(job._id);
  assert.equal(j!.done, true);
  assert.equal(j!.sentCount, 100);
  assert.equal(j!.leaseOwner, undefined);
});

test("L2. a stale lease (dead worker) is taken over and the run resumes from the saved cursor", async () => {
  const job = await M.createBroadcastJob("hello", 1);
  const { api: api1, sent: s1 } = fakeApi();
  await bp.processBroadcastBatch(api1, job, { budgetMs: -1 }); // sends one user, then stops on the budget
  assert.equal(s1.length, 1);
  // a crashed worker still "holds" the lease, but it has expired
  const { getDb } = await import("../../src/db/connect.js");
  await (await getDb()).collection<any>("broadcast_jobs").updateOne({ _id: job._id }, { $set: { leaseOwner: "dead", leaseUntil: new Date(Date.now() - 1000) } });
  const { api: api2, sent: s2 } = fakeApi();
  await bp.processBroadcastBatch(api2, job);
  assert.equal(s2.length, 99);
  assert.ok(!s2.includes(s1[0]!));
  assert.equal((await M.getBroadcastJob(job._id))!.sentCount, 100);
});

test("L3. a LIVE lease of another worker blocks this one", async () => {
  const job = await M.createBroadcastJob("hello", 1);
  assert.ok(await M.claimBroadcastLease(job._id, "other", 60_000));
  const { api, sent } = fakeApi();
  await bp.processBroadcastBatch(api, job);
  assert.equal(sent.length, 0);
});

test("L4. a worker that lost its lease cannot move the cursor or double count (CAS)", async () => {
  const job = await M.createBroadcastJob("hello", 1);
  assert.ok(await M.claimBroadcastLease(job._id, "A", 60_000));
  assert.equal(await M.advanceBroadcast(job._id, "A", -1, 1001, 1, 0, false, 60_000), true);
  assert.equal(await M.advanceBroadcast(job._id, "A", -1, 1001, 1, 0, false, 60_000), false, "same cursor twice");
  assert.equal(await M.advanceBroadcast(job._id, "B", 1001, 1002, 1, 0, false, 60_000), false, "not the owner");
  assert.equal((await M.getBroadcastJob(job._id))!.sentCount, 1);
});

test("L5. blocked users count as failed and are skipped; a transient error stops WITHOUT skipping the user", async () => {
  const job = await M.createBroadcastJob("hello", 1);
  let boom = true;
  const { api, sent } = fakeApi((id) => (id === 1003 ? { error_code: 403 } : id === 1005 && boom ? { error_code: 429 } : null));
  await bp.processBroadcastBatch(api, job);
  let j = (await M.getBroadcastJob(job._id))!;
  assert.equal(j.done, false);
  assert.equal(j.cursorId, 1004, "stopped before user 1005");
  assert.equal(j.failCount, 1);
  boom = false;
  await bp.processBroadcastBatch(api, j);
  j = (await M.getBroadcastJob(job._id))!;
  assert.equal(j.done, true);
  assert.ok(sent.includes(1005));
  assert.equal(j.sentCount, 99);
  assert.equal(j.failCount, 1);
});
