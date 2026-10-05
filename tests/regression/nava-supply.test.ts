/** v1.12.0: Nava-side rewards are drawn from the finite wallet supply and never break when it is exhausted. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const R = await import("../../src/db/models/relic.js");

const setSupply = (remaining: number) =>
  col("wallet_supply").updateOne({ _id: "supply" }, { $set: { cap: 1000, remaining, issued: 1000 - remaining, feesCollected: 0 } }, { upsert: true } as any);
const supply = () => col("wallet_supply").byId("supply");
const bal = (id: number) => col("users").byId(id).relicBalance;

beforeEach(async () => {
  resetFakeMongo();
  await setSupply(1000);
  for (const id of [1, 2, 3]) seedUser({ id, nickname: `N${id}`, anonId: `user_B${id}`, relicBalance: 0 });
});

test("referral reward is drawn from supply and is idempotent", async () => {
  assert.equal(await R.grantReferralRewardOnce(1, 2), true);
  assert.equal(await R.grantReferralRewardOnce(1, 2), false);
  assert.equal(supply().remaining + bal(1), 1000);
  assert.ok(bal(1) > 0);
});

test("exhausted supply: reward is skipped cleanly, nothing credited, nothing thrown, retried after top-up", async () => {
  await setSupply(0);
  assert.equal(await R.grantReferralRewardOnce(1, 2), false);
  assert.equal(await R.grantReportRewardOnce(1, "rep1"), false);
  assert.equal(bal(1), 0);
  assert.equal(supply().remaining, 0);
  await setSupply(1000);
  assert.equal(await R.grantReferralRewardOnce(1, 2), true);
  assert.ok(bal(1) > 0);
});

test("initial gift: drawn once, never double-drawn, skipped (flag unset) when exhausted", async () => {
  const users = (await import("../../src/db/connect.js")).getDb;
  const uc = (await users()).collection<any>("users");
  await uc.updateMany({}, { $set: { relicInitialized: false } });
  await R.grantInitialBalanceIfNeeded(1, uc);
  await R.grantInitialBalanceIfNeeded(1, uc);
  assert.equal(bal(1), 5);
  assert.equal(supply().remaining, 995);
  await setSupply(0);
  await R.grantInitialBalanceIfNeeded(2, uc);
  assert.equal(bal(2), 0);
  assert.notEqual(col("users").byId(2).relicInitialized, true);
  await setSupply(100);
  await R.grantInitialBalanceIfNeeded(2, uc);
  assert.equal(bal(2), 5);
});

test("purchases and admin adjustments do not touch the supply", async () => {
  await setSupply(0);
  assert.equal(await R.creditPurchaseOnce(3, "ref1", 10, 50), true);
  assert.equal(bal(3), 10);
  assert.equal(supply().remaining, 0);
});
