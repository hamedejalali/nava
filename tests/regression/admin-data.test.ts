import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

await createHarness();
beforeEach(() => resetState());

// ------------------------------------------------------------------ i
test("i. approval requests go to the OWNER only; fall back to all admins only when OWNER_ID is unset", async () => {
  const { getRequestRecipientIds } = await import("../../src/features/admin/constants.js");
  seedUser({ id: 31, isAdmin: true });
  assert.deepEqual(await getRequestRecipientIds(), [OWNER_ID]);

  const saved = process.env.OWNER_ID;
  delete process.env.OWNER_ID;
  try {
    const ids = (await getRequestRecipientIds()).sort();
    assert.deepEqual(ids, [ADMIN_ID, 31].sort(), "never silently nobody");
  } finally {
    process.env.OWNER_ID = saved;
  }
});

// ------------------------------------------------------------------ j
async function writeSheet(rows: Array<Record<string, any>>): Promise<{ file: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "nava-import-"));
  const file = join(dir, "users.xlsx");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("users");
  const headers = ["telegramId", "anonId", "firstName", "username", "nickname", "gender", "age", "province", "city", "languageCode", "level", "verified", "banned", "banReason", "isAdmin", "relicBalance", "relicInitialized", "referredBy", "channelsExempt", "onboardingStep"];
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((k) => r[k] ?? ""));
  await wb.xlsx.writeFile(file);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("j. import: new user restored incl. balance; existing user's balance/init NEVER overwritten", async () => {
  const { importUsersFromExcel } = await import("../../src/services/userImport.js");
  seedUser({ id: 500, relicBalance: 42, relicInitialized: true, nickname: "old" });
  const { file, cleanup } = await writeSheet([
    { telegramId: 500, anonId: "user_Exist1", firstName: "E", nickname: "newnick", relicBalance: 99999, relicInitialized: false },
    { telegramId: 501, anonId: "user_Brand1", firstName: "N", nickname: "fresh", relicBalance: 7, relicInitialized: true, gender: "male", age: 30 },
    { telegramId: "abc", firstName: "bad" },
    { telegramId: 501, firstName: "dup-in-file", relicBalance: 1000 },
  ]);
  try {
    const report = await importUsersFromExcel(file);
    assert.deepEqual({ i: report.imported, u: report.updated, s: report.skipped, inv: report.invalid, f: report.failed }, { i: 1, u: 1, s: 1, inv: 1, f: 0 });
    assert.equal(col("users").byId(500).relicBalance, 42, "existing balance untouched");
    assert.equal(col("users").byId(500).relicInitialized, true, "existing init flag untouched");
    assert.equal(col("users").byId(500).nickname, "newnick", "profile field updated");
    assert.equal(col("users").byId(501).relicBalance, 7);
    assert.equal(col("users").byId(501).anonId, "user_Brand1");

    const again = await importUsersFromExcel(file); // idempotent re-import
    assert.equal(again.imported, 0);
    assert.equal(again.updated, 2);
    assert.equal(col("users").byId(501).relicBalance, 7, "re-import never doubles a balance");
    assert.equal(col("users").all().length, 2);
  } finally {
    cleanup();
  }
});

test("j. two imports of the same sheet at the same time create no duplicates and never double the balance", async () => {
  const { importUsersFromExcel } = await import("../../src/services/userImport.js");
  const { file, cleanup } = await writeSheet([
    { telegramId: 600, anonId: "user_Conc01", firstName: "C", relicBalance: 25, relicInitialized: true },
    { telegramId: 601, anonId: "user_Conc02", firstName: "D", relicBalance: 30, relicInitialized: true },
  ]);
  try {
    const [r1, r2] = await Promise.all([importUsersFromExcel(file), importUsersFromExcel(file)]);
    assert.equal(col("users").all().length, 2);
    assert.equal(col("users").byId(600).relicBalance, 25);
    assert.equal(col("users").byId(601).relicBalance, 30);
    assert.equal(r1.failed + r2.failed, 0);
    assert.equal(r1.imported + r2.imported, 2, "each user is 'imported' exactly once across both runs");
    assert.equal(r1.updated + r2.updated, 2);
  } finally {
    cleanup();
  }
});

test("j. export writes profile + wallet fields only (no photos / secrets) and round-trips through import", async () => {
  const { exportUsersToExcel } = await import("../../src/services/userExport.js");
  const { importUsersFromExcel } = await import("../../src/services/userImport.js");
  seedUser({ id: 700, relicBalance: 12, profilePhotoFileId: "SECRET_PHOTO_FILE_ID", bio: "private bio" });
  const dir = mkdtempSync(join(tmpdir(), "nava-export-"));
  const file = join(dir, "out.xlsx");
  try {
    assert.equal(await exportUsersToExcel(file), 1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const text = JSON.stringify(wb.worksheets[0]!.getSheetValues());
    assert.ok(!text.includes("SECRET_PHOTO_FILE_ID") && !text.includes("private bio"));
    const headers = (wb.worksheets[0]!.getRow(1).values as any[]).filter(Boolean);
    assert.ok(headers.includes("relicBalance") && headers.includes("telegramId"));
    assert.ok(!headers.includes("profilePhotoFileId") && !headers.includes("location"));

    resetState();
    const report = await importUsersFromExcel(file);
    assert.equal(report.imported, 1);
    assert.equal(col("users").byId(700).relicBalance, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ k
test("k. public Nava ID: well-formed, unique across many users, generated from a CSPRNG", async () => {
  const { getOrCreateUser } = await import("../../src/db/models/user.js");
  const ids = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const u = await getOrCreateUser({ telegramId: 10_000 + i, firstName: "x" });
    assert.match(u.anonId, /^user_[A-Za-z0-9]{6}$/);
    ids.add(u.anonId);
  }
  assert.equal(ids.size, 300);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/db/models/user.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function generateAnonId"), src.indexOf("function generateAnonId") + 400);
  assert.ok(fn.includes("randomBytes") && !fn.includes("Math.random"));
});
