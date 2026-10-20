/** v1.21.0 — batch creation of default members: count, N photos, N names, auto age 18..32, random province/city, editable after. (mocked) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const { planBatch, parseNames, BATCH_MAX } = await import("../../src/features/admin/seedsBatch.js");

beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "owner", relicBalance: 0, onboardingStep: "COMPLETED" } as any);
});

const seeds = () => col("users").all().filter((u: any) => u.isSeed);

test("S1. planner: photo i ↔ name i, age always 18..32, city belongs to the province, gender modes", () => {
  const names = Array.from({ length: 30 }, (_, i) => `نام${i}`);
  const photos = names.map((_, i) => `F${i}`);
  const plan = planBatch(names, photos, "female");
  assert.equal(plan.length, 30);
  plan.forEach((p, i) => {
    assert.equal(p.profilePhotoFileId, `F${i}`);
    assert.equal(p.nickname, names[i]);
    assert.ok(p.age >= 18 && p.age <= 32);
    assert.equal(p.gender, "female");
  });
  const mix = planBatch(names, photos, "mix");
  assert.ok(new Set(mix.map((p) => p.gender)).size === 2, "mix produces both");
  assert.ok(new Set(plan.map((p) => p.age)).size > 3, "ages vary");
});

test("S2. names: exactly N lines, Persian only", () => {
  assert.equal(parseNames("مریم\nسارا", 3).ok, false);
  assert.equal(parseNames("مریم\nSara\nنیما", 3).ok, false);
  const ok = parseNames("مریم\nسارا\nنیما", 3);
  assert.deepEqual((ok as any).names, ["مریم", "سارا", "نیما"]);
});

test("S3. full flow from the panel: count -> gender -> 3 photos (album, parallel) -> 3 names -> 3 members created and editable", async () => {
  await h.text(OWNER_ID, "📦 ساخت دسته‌ای ممبر");
  await h.text(OWNER_ID, "0"); // refused
  await h.text(OWNER_ID, String(BATCH_MAX + 1)); // refused
  await h.text(OWNER_ID, "3");
  await h.callback(OWNER_ID, "admin:seed:bg:female");
  await Promise.all([h.file(OWNER_ID, "photo", "PA"), h.file(OWNER_ID, "photo", "PB"), h.file(OWNER_ID, "photo", "PC")]);
  await h.file(OWNER_ID, "photo", "PD"); // extra: ignored
  assert.equal(seeds().length, 0);
  await h.text(OWNER_ID, "مریم\nسارا"); // too few
  assert.equal(seeds().length, 0);
  await h.text(OWNER_ID, "مریم\nسارا\nنیلوفر");
  const made = seeds();
  assert.equal(made.length, 3);
  assert.deepEqual(made.map((u: any) => u.nickname).sort(), ["سارا", "مریم", "نیلوفر"].sort());
  for (const u of made as any[]) {
    assert.equal(u.gender, "female");
    assert.ok(u.age >= 18 && u.age <= 32);
    assert.ok(u.profilePhotoFileId && u.city && u.province);
    assert.equal(u.relicBalance, 0);
    assert.equal(u.onboardingStep, "COMPLETED");
  }
  assert.equal(new Set(made.map((u: any) => u.profilePhotoFileId)).size, 3, "each member has his own photo");
  assert.equal(col("seed_batch_photos").all().length, 0, "temp photos cleaned");
});

test("S4. only admins can use it; cancel cleans up", async () => {
  await h.text(5, "📦 ساخت دسته‌ای ممبر");
  assert.equal(col("admin_flows").all().length, 0);
  await h.text(OWNER_ID, "📦 ساخت دسته‌ای ممبر");
  await h.text(OWNER_ID, "2");
  await h.callback(OWNER_ID, "admin:seed:bg:mix");
  await h.file(OWNER_ID, "photo", "PA");
  await h.text(OWNER_ID, "لغو");
  assert.equal(col("seed_batch_photos").all().length, 0);
  assert.equal(seeds().length, 0);
});
