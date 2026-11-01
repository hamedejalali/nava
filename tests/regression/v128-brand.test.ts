/** v1.28.0 — brand migration (dry-run, CAS, rollback) + visible-string scan (mocked Mongo) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { col } from "../harness/fakeMongo.js";

await createHarness({});
const m = await import("../../src/services/brandMigration.js");
const { getDb } = await import("../../src/db/connect.js");
const put = async (id: string, text: string) => (await getDb()).collection<any>("content").insertOne({ _id: id, text, updatedAt: new Date() });
beforeEach(() => resetState());

test("M1. dry run changes nothing; apply renames whole words only, skips supportId; rollback restores", async () => {
  await put("welcome", "به نوا خوش اومدی؛ نوا گرام رو ببین"); await put("other", "نوازش و موسیقی"); await put("supportId", "@nava_support");
  const plan = await m.planBrandMigration();
  assert.equal(plan.changes.length, 1);
  assert.equal(col("content").byId("welcome")!.text, "به نوا خوش اومدی؛ نوا گرام رو ببین", "dry run wrote nothing");
  const r = await m.applyBrandMigration(plan);
  assert.equal(r.applied, 1); assert.ok(r.integrity.ok);
  assert.equal(col("content").byId("welcome")!.text, "به مویا خوش اومدی؛ مویاگرام رو ببین");
  assert.equal(col("content").byId("other")!.text, "نوازش و موسیقی", "نوازش is not the brand");
  assert.equal(col("content").byId("supportId")!.text, "@nava_support");
  const rb = await m.rollbackBrandMigration(r.backup);
  assert.equal(rb.restored, 1);
  assert.equal(col("content").byId("welcome")!.text, "به نوا خوش اومدی؛ نوا گرام رو ببین");
});

test("M2. a text edited between plan and apply is NOT overwritten (compare-and-set); re-running is a no-op", async () => {
  await put("t", "سلام نوا");
  const plan = await m.planBrandMigration();
  (await getDb()).collection<any>("content").updateOne({ _id: "t" }, { $set: { text: "متن جدید ادمین" } });
  await new Promise((r) => setTimeout(r, 5));
  const r = await m.applyBrandMigration(plan);
  assert.equal(r.applied, 0); assert.equal(r.skippedChanged, 1);
  assert.equal(col("content").byId("t")!.text, "متن جدید ادمین");
  assert.equal((await m.planBrandMigration()).changes.length, 0);
});

test("M3. user-visible monitor page and menu button no longer show the old brand", () => {
  const html = readFileSync("public/monitor/index.html", "utf8");
  assert.ok(!/>Nava</.test(html) && !html.includes("(Nava)"));
  assert.ok(!readFileSync("scripts/set-menu-button.ts", "utf8").includes('text: "نوا"'));
});
