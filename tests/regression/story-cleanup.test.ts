/** Defect B: cleanupStories must not be starved by highlighted (retained) stories sitting at the front. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
installFakeMongo();
const { cleanupStories } = await import("../../src/services/nava/stories.js");
beforeEach(() => resetFakeMongo());

const DAY = 86_400_000;
const now = new Date();
async function story(id: string, ageDays: number, ownerId = 1) {
  await col("mini_stories").insertOne({ _id: id, ownerId, mediaId: "m_" + id, createdAt: new Date(now.getTime() - ageDays * DAY), expiresAt: new Date(now.getTime() - (ageDays - 1) * DAY) } as any);
  await col("mini_media").insertOne({ _id: "m_" + id, data: "x" } as any).catch(() => {});
  await col("mini_story_views").insertOne({ _id: "v_" + id, storyId: id } as any).catch(() => {});
}
const left = () => col("mini_stories").all().map((s: any) => s._id).sort();

test("B1. retained (highlighted) stories at the front of the queue do not starve older non-retained ones behind them", async () => {
  // 6 highlighted, OLDEST stories + 4 non-highlighted slightly newer ones; batch size 3 < 6
  const kept = ["h1", "h2", "h3", "h4", "h5", "h6"];
  for (const [i, id] of kept.entries()) await story(id, 100 - i);
  const doomed = ["d1", "d2", "d3", "d4"];
  for (const [i, id] of doomed.entries()) await story(id, 60 - i);
  await col("mini_highlights").insertOne({ _id: "H", ownerId: 1, title: "t", storyIds: kept, createdAt: now } as any);
  const dropped = await cleanupStories(now, 3);
  assert.equal(dropped, 3, "makes progress despite a first page that is entirely retained");
  assert.deepEqual(left().filter((i) => kept.includes(i)), [...kept].sort(), "highlighted stories are never deleted");
  assert.equal(await cleanupStories(now, 3), 1);
  assert.deepEqual(left(), [...kept].sort());
  assert.equal(col("mini_story_views").all().filter((v: any) => doomed.includes(v.storyId)).length, 0, "views of dropped stories are removed");
  assert.equal(await cleanupStories(now, 3), 0, "idempotent when nothing is left to drop");
});

test("B2. recent (<30 days) stories are never touched", async () => {
  await story("new1", 5); await story("old1", 45);
  assert.equal(await cleanupStories(now, 10), 1);
  assert.deepEqual(left(), ["new1"]);
});

test("B3. work per run is bounded by batch / maxPages", async () => {
  for (let i = 0; i < 30; i++) await story("s" + String(i).padStart(2, "0"), 90 - i);
  assert.equal(await cleanupStories(now, 7, 25), 7);
  assert.equal(col("mini_stories").all().length, 23);
  // with every candidate retained the walk stops at maxPages instead of scanning forever
  const all = col("mini_stories").all().map((s: any) => s._id);
  await col("mini_highlights").insertOne({ _id: "H", ownerId: 1, title: "t", storyIds: all, createdAt: now } as any);
  assert.equal(await cleanupStories(now, 5, 2), 0);
  assert.equal(col("mini_stories").all().length, 23);
});
