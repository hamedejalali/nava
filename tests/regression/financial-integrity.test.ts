/** v1.16.3 — financial integrity audit: every balance path is idempotent / concurrency-safe and reconciles with the ledger. (in-memory Mongo fake: transactions emulated) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const A = 8301, B = 8302, C = 8303;
const bal = (id: number) => col("users").byId(id).relicBalance;
const ledger = () => col("relic_transactions").all();
const sum = (id: number, types?: string[]) => ledger().filter((r: any) => r.userId === id && (!types || types.includes(r.type))).reduce((s: number, r: any) => s + r.amount, 0);
const R = () => import("../../src/db/models/relic.js");
beforeEach(() => {
  resetState(); h.resetCalls();
  seedUser({ id: A, nickname: "a", relicBalance: 10, relicInitialized: true, gender: "male" });
  seedUser({ id: B, nickname: "b", relicBalance: 0, relicInitialized: true, gender: "female" });
  seedUser({ id: C, nickname: "c", relicBalance: 0, relicInitialized: false, gender: "female" });
});

test("F1. REGRESSION: double tap on 'confirm transfer' (two different updates) moves the Relic ONCE and notifies the recipient ONCE", async () => {
  const { CHAT_CALLBACKS } = await import("../../src/features/matching/constants.js");
  await h.callback(A, `${CHAT_CALLBACKS.transfer}:${B}`);
  await h.text(A, "3");
  h.resetCalls();
  await Promise.all([h.callback(A, CHAT_CALLBACKS.transferConfirm), h.callback(A, CHAT_CALLBACKS.transferConfirm)]);
  assert.equal(bal(A), 7); assert.equal(bal(B), 3);
  assert.equal(ledger().filter((r: any) => r.type === "TRANSFER" && r.amount < 0).length, 1, "one debit row (plus its one credit row)");
  assert.equal(ledger().filter((r: any) => r.type === "TRANSFER").length, 2);
  assert.equal(h.of("sendMessage", B).length, 1, "recipient told once");
});

test("F2. two LEGITIMATE transfers of the same amount to the same person in the same second are NOT merged", async () => {
  const { CHAT_CALLBACKS } = await import("../../src/features/matching/constants.js");
  for (let i = 0; i < 2; i++) {
    await h.callback(A, `${CHAT_CALLBACKS.transfer}:${B}`);
    await h.text(A, "2");
    await h.callback(A, CHAT_CALLBACKS.transferConfirm);
  }
  assert.equal(bal(A), 6); assert.equal(bal(B), 4);
  assert.equal(ledger().filter((r: any) => r.type === "TRANSFER" && r.amount < 0).length, 2);
});

test("F3. transferRelicOnce: same operation id twice (retry) -> one transfer; 12 concurrent distinct transfers of 1 from a balance of 10 -> exactly 10 succeed, never negative", async () => {
  const { transferRelicOnce } = await R();
  assert.equal((await transferRelicOnce("op-1", A, B, 1)).status, "completed");
  assert.equal((await transferRelicOnce("op-1", A, B, 1)).status, "already_processed");
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => transferRelicOnce(`op-c-${i}`, A, B, 1)));
  assert.equal(rs.filter((r) => r.status === "completed").length, 9, "10 - the first one");
  assert.equal(bal(A), 0); assert.equal(bal(B), 10);
  assert.equal(sum(A, ["TRANSFER"]), -10);
});

test("F4. transfer to a missing recipient rolls the debit back (no Relic vanishes)", async () => {
  const { transferRelicOnce } = await R();
  assert.equal((await transferRelicOnce("op-x", A, 999999, 4)).status, "invalid");
  assert.equal(bal(A), 10);
  assert.equal(ledger().filter((r: any) => r.type === "TRANSFER").length, 0);
});

test("F5. initial 5-Relic grant: 6 concurrent triggers grant it once, with one ledger row", async () => {
  const { grantInitialBalanceIfNeeded } = await R();
  const users = (await import("../../src/db/connect.js")).getDb;
  const usersCol = (await users()).collection<any>("users");
  await Promise.all(Array.from({ length: 6 }, () => grantInitialBalanceIfNeeded(C, usersCol)));
  assert.equal(bal(C), 5);
  assert.equal(ledger().filter((r: any) => r.type === "INITIAL_BALANCE" && r.userId === C).length, 1);
});

test("F6. referral reward / profile bonus / report reward: concurrent duplicates credit once", async () => {
  const R_ = await R();
  await Promise.all(Array.from({ length: 5 }, () => R_.grantReferralRewardOnce(A, B)));
  await Promise.all(Array.from({ length: 5 }, () => R_.grantProfileCompletionRewardOnce(B)));
  await Promise.all(Array.from({ length: 5 }, () => R_.grantReportRewardOnce(B, "rep-1")));
  assert.equal(bal(A), 30); assert.equal(bal(B), 10);
  assert.equal(ledger().length, 3);
});

test("F7. chat-cost refund: concurrent duplicates credit once", async () => {
  const R_ = await R();
  const rs = await Promise.all(Array.from({ length: 6 }, () => R_.refundChatCostOnce(A, "SESS-1")));
  assert.equal(rs.filter(Boolean).length, 1);
  assert.equal(bal(A), 11);
});

test("F8. admin adjustment: a negative adjustment can never push the balance below zero, even concurrently; each applied one has a ledger row", async () => {
  const { adminAdjustBalance } = await R();
  const rs = await Promise.all(Array.from({ length: 8 }, () => adminAdjustBalance(ADMIN, A, -3, "t")));
  const applied = rs.filter((r) => r.status === "applied").length;
  assert.equal(applied, 3);
  assert.equal(bal(A), 1);
  assert.equal(ledger().filter((r: any) => r.type === "ADMIN_ADJUSTMENT").length, applied);
  assert.equal((await adminAdjustBalance(ADMIN, A, 0, "t")).status, "invalid");
});
const ADMIN = 901;

test("F9. RECONCILIATION: after a mixed concurrent workload, each balance == its starting balance + the sum of its ledger rows", async () => {
  const R_ = await R();
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => R_.transferRelicOnce(`m-${i}`, A, B, 1)),
    R_.grantReferralRewardOnce(A, C),
    R_.refundChatCostOnce(B, "S9"),
    R_.adminAdjustBalance(ADMIN, A, -2, "t"),
    R_.adminAdjustBalance(ADMIN, B, 4, "t"),
  ]);
  assert.equal(bal(A), 10 + sum(A));
  assert.equal(bal(B), 0 + sum(B));
});
