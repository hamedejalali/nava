/** v1.30.3 — `isPrivate` index review. MOCK TESTS ONLY: the fake MongoDB records index DEFINITIONS and never plans queries, so nothing here proves
 *  a real execution plan. P3 uses SYNTHETIC explain documents to test the verdict logic of scripts/explain-hot-queries.ts. Real IXSCAN / COLLSCAN
 *  evidence exists only when that script is run against a real (staging) MongoDB — NOT done in this environment. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";
import { planStages, planVerdict, casePasses } from "../../scripts/queryPlan.js";

await createHarness();
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { ensureUserIndexes } = await import("../../src/db/models/user.js");
const { lockedOwnerIds } = await import("../../src/services/nava/common.js");
const idx = () => (col("users") as any).indexes as Array<{ name: string; key: any; partialFilterExpression?: any }>;
const onPrivate = () => idx().filter((i) => Object.keys(i.key).length === 1 && i.key.isPrivate === 1);

test("P1. the isPrivate partial index already exists (`private_pages`, created by the Mini App social setup) and is defined exactly once", async () => {
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 100));
  await ensureUserIndexes();
  const found = onPrivate();
  assert.equal(found.length, 1, "exactly one index on isPrivate — a second one with another NAME would make createIndexes fail with IndexOptionsConflict");
  assert.equal(found[0]!.name, "private_pages");
  assert.deepEqual(found[0]!.partialFilterExpression, { isPrivate: true });
});

test("P2. lockedOwnerIds: private owners the viewer does not follow are locked; followed, own and non-private ones are not; staff see everything", async () => {
  resetState();
  seedUser({ id: 9301, nickname: "Viewer" });
  seedUser({ id: 9302, nickname: "Priv A", isPrivate: true });
  seedUser({ id: 9303, nickname: "Priv B", isPrivate: true });
  seedUser({ id: 9304, nickname: "Open" });
  await col("mini_follows").insertOne({ _id: "9301:9303", followerId: 9301, followeeId: 9303, createdAt: new Date() } as any);
  assert.deepEqual(await lockedOwnerIds(9301), [9302]);
  assert.deepEqual((await lockedOwnerIds(9302)).sort(), [9303]);
  assert.deepEqual(await lockedOwnerIds(OWNER_ID), []);
});

test("P3. [SYNTHETIC explain documents] the verdict logic reads the whole winning plan and never passes an unknown shape", () => {
  const ix = { queryPlanner: { winningPlan: { stage: "PROJECTION_COVERED", inputStage: { stage: "IXSCAN", indexName: "private_pages" } } } };
  const cs = { queryPlanner: { winningPlan: { stage: "PROJECTION_SIMPLE", inputStage: { stage: "COLLSCAN" } } } };
  const orMixed = { queryPlanner: { winningPlan: { stage: "SUBPLAN", inputStage: { stage: "OR", inputStages: [{ stage: "FETCH", inputStage: { stage: "IXSCAN" } }, { stage: "COLLSCAN" }] } } } };
  const orIx = { queryPlanner: { winningPlan: { stage: "FETCH", inputStage: { stage: "OR", inputStages: [{ stage: "IXSCAN" }, { stage: "IXSCAN" }] } } } };
  assert.equal(planVerdict(ix), "IXSCAN");
  assert.equal(planVerdict(cs), "COLLSCAN");
  assert.equal(planVerdict(orMixed), "COLLSCAN", "one scanned branch of an $or is still a collection scan");
  assert.equal(planVerdict(orIx), "IXSCAN");
  assert.equal(planVerdict({}), "UNKNOWN");
  assert.equal(planVerdict({ queryPlanner: { winningPlan: { stage: "EOF" } } }), "UNKNOWN");
  assert.deepEqual(planStages(orMixed.queryPlanner.winningPlan), ["SUBPLAN", "OR", "FETCH", "IXSCAN", "COLLSCAN"]);
  assert.equal(casePasses(true, "IXSCAN"), true);
  for (const v of ["COLLSCAN", "UNKNOWN"] as const) assert.equal(casePasses(true, v), false, v);
  assert.equal(casePasses(false, "COLLSCAN"), true, "informational cases never fail the run");
});
