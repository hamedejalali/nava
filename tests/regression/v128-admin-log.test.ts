/** v1.28.1 — readable Persian admin logs (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHarness, resetState, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, keepPersianFixtureNames } from "../harness/fakeMongo.js";
keepPersianFixtureNames();

await createHarness({});
const { describeAdminAction, ADMIN_ACTIONS } = await import("../../src/services/adminAudit.js");
beforeEach(() => {
  resetState();
  seedUser({ id: ADMIN_ID, anonId: "user_ptkqf1", nickname: "Moya" } as any);
  seedUser({ id: 8778289650, anonId: "user_ZZZ111", nickname: "علی", username: "ali_t" } as any);
});

test("A1. maintenance_allow_add shows who did what to whom — no raw key", async () => {
  const t = await describeAdminAction(ADMIN_ID, "maintenance_allow_add", "8778289650");
  assert.match(t, /ادمین: Moya — user_ptkqf1/);
  assert.match(t, /به لیست مجازهای خاموشی اضافه کرد/);
  assert.match(t, /علی — user_ZZZ111 — @ali_t — 8778289650/);
  assert.ok(!t.includes("maintenance_allow_add"));
});

test("A2. toggles and values read like sentences", async () => {
  assert.match(await describeAdminAction(ADMIN_ID, "toggle_maintenance", "true"), /ربات برای کاربران عادی خاموش شد/);
  assert.match(await describeAdminAction(ADMIN_ID, "toggle_maintenance", "false"), /دوباره روشن شد/);
  assert.match(await describeAdminAction(ADMIN_ID, "jeton_send", "8778289650:25"), /مقدار: 25 ژتون/);
  assert.match(await describeAdminAction(ADMIN_ID, "admin_perms", "8778289650:ban=off"), /بن و آن‌بن.*خاموش شد/);
  assert.match(await describeAdminAction(ADMIN_ID, "route_set", "adminLog:dm"), /لاگ کارهای ادمین‌ها ← پیام خصوصی/);
  assert.match(await describeAdminAction(ADMIN_ID, "ban_user", "8778289650 (report abc)"), /report abc/);
});

test("A3. an unknown action is clearly marked, never a bare code line", async () => {
  const t = await describeAdminAction(ADMIN_ID, "something_new", "x");
  assert.match(t, /اقدام ثبت‌نشده/);
});

test("A4. every action key used anywhere in the code has a Persian description", () => {
  const keys = new Set<string>();
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/logAdminAction\(([^;]*?)\);/gs)) for (const k of m[1]!.matchAll(/"([a-z][a-z_]+)"/g)) keys.add(k[1]!);
  } } };
  walk("src"); walk("api");
  for (const detail of ["true", "noop", "on", "off", "username_taken", "ok", "photo", "approved"]) keys.delete(detail); // detail values that appear as literals, not action keys
  const missing = [...keys].filter((k) => !ADMIN_ACTIONS[k]);
  assert.deepEqual(missing, [], "describe these in ADMIN_ACTIONS");
});
