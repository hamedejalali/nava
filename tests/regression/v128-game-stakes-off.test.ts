/** v1.28.0 — Jeton stakes are refused on the server; legacy staked tables are refunded; unfinished games are never purged (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const bg = await import("../../src/services/games/backgammonGames.js");
const { getDb } = await import("../../src/db/connect.js");

const mk = (id: number, bal = 100) => seedUser({ id, anonId: `user_G${String(id).padStart(5, "0")}`, nickname: "n" + id, age: 25, relicBalance: bal, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
const bal = async (id: number) => ((await col("users").findOne({ _id: id })) as any).relicBalance as number;
const old = (days: number) => new Date(Date.now() - days * 86_400_000);
beforeEach(() => { resetState(); mk(1); mk(2); });

test("B1. creating a staked table is refused and nothing is charged", async () => {
  for (const stake of [1, 5, 100, -3, 2.5, "5", 1e9]) {
    await assert.rejects(bg.create({ _id: 1, anonId: "user_G00001" }, stake as any), (e: any) => e.code === "stakes_disabled");
  }
  assert.equal(await bal(1), 100);
  assert.equal(col("bg_games").count(), 0);
  const free = await bg.create({ _id: 1, anonId: "user_G00001" }, 0);
  assert.equal(free.stake, 0);
  assert.deepEqual((await bg.lobby({ _id: 1, anonId: "user_G00001" })).stakes, [0]);
});

test("B2. a legacy staked waiting table cannot be joined and the host's chips come back at once", async () => {
  await (await getDb()).collection<any>("bg_games").insertOne({ _id: "legacy1", status: "waiting", players: [1, 0], state: null, v: 1, last: null, createdAt: new Date(), updatedAt: new Date(), stake: 20 });
  await (await getDb()).collection<any>("users").updateOne({ _id: 1 }, { $set: { relicBalance: 80 } });
  await assert.rejects(bg.join({ _id: 2, anonId: "user_G00002" }, "legacy1"), (e: any) => e.code === "stakes_disabled");
  assert.equal(await bal(2), 100, "the would-be opponent is never charged");
  assert.equal(await bal(1), 100, "host refunded");
  assert.equal(col("bg_games").byId("legacy1")!.status, "finished");
  await assert.rejects(bg.join({ _id: 2, anonId: "user_G00002" }, "legacy1"));
  assert.equal(await bal(1), 100, "refunded exactly once");
});

test("B3. purge never deletes waiting / active / unsettled games, only old finished+settled or free ones", async () => {
  const d = (await getDb()).collection<any>("bg_games");
  const base = { players: [1, 2], state: null, v: 1, last: null, createdAt: old(10), updatedAt: old(10) };
  await d.insertMany([
    { ...base, _id: "act", status: "active", stake: 5 },
    { ...base, _id: "wait", status: "waiting", stake: 5 },
    { ...base, _id: "unsettled", status: "finished", stake: 5, settled: false },
    { ...base, _id: "settled", status: "finished", stake: 5, settled: true },
    { ...base, _id: "free", status: "finished", stake: 0 },
    { ...base, _id: "freeNew", status: "finished", stake: 0, updatedAt: new Date() },
  ]);
  await bg.purgeFinishedGames();
  const left = col("bg_games").where({}).map((x: any) => x._id).sort();
  assert.deepEqual(left, ["act", "freeNew", "unsettled", "wait"]);
});

test("B4. reconcile: a stake whose game vanished (old TTL) is refunded once; in-play / paid ones are untouched", async () => {
  const { reconcileBgStakes } = await import("../../src/services/games/bgReconcile.js");
  const db = await getDb();
  const L = db.collection<any>("relic_transactions");
  const row = (id: string, userId: number, amount: number, type = "GAME_STAKE") => L.insertOne({ _id: id, userId, amount, type, status: "completed", createdAt: new Date() });
  await row("gstake:lost:1", 1, -10); await row("gstake:lost:2", 2, -10);          // game doc gone, no payout
  await row("gstake:paid:1", 1, -4); await row("gwin:paid", 2, 8, "GAME_WIN");       // doc gone but the pot was paid
  await row("gstake:live:1", 1, -3);
  await db.collection<any>("bg_games").insertOne({ _id: "live", status: "active", players: [1, 2], state: null, v: 1, last: null, createdAt: new Date(), updatedAt: new Date(), stake: 3 });
  const before = [await bal(1), await bal(2)];
  const dry = await reconcileBgStakes();
  assert.equal(dry.missingGameUnpaid.length, 2);
  assert.deepEqual(dry.inPlay, ["live"]);
  assert.deepEqual([await bal(1), await bal(2)], before, "report-only changes nothing");
  const a = await reconcileBgStakes({ apply: true });
  assert.equal(a.refunded, 2);
  assert.deepEqual([await bal(1), await bal(2)], [before[0]! + 10, before[1]! + 10]);
  const again = await reconcileBgStakes({ apply: true });
  assert.equal(again.refunded, 0);
  assert.deepEqual([await bal(1), await bal(2)], [before[0]! + 10, before[1]! + 10], "idempotent");
});
