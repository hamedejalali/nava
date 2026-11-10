/** v1.29.7 — wallet-sync alert (streak + plain explanation), jeton menu on the reply keyboard, glass lists, red cancel on the last prompts.
 *  MOCK TESTS (fake MongoDB / Telegram): they prove application logic only. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const Ops = await import("../../src/services/monitorOps.js");
const NOW = new Date("2026-11-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const min = 60_000;
beforeEach(() => { resetState(); h.resetCalls(); });
const wallet = async (doc: Record<string, unknown>) => {
  await col("wallet_sync").insertOne({ _id: "cursor", ...doc } as any);
  const o = await Ops.collectOps(NOW, { CRON_SECRET: "x" });
  return (o.payments as any).value as { walletSyncFailing: boolean; walletSyncError: string | null };
};

test("U1. one timeout is NOT an alert; 3 failures in a row with no success for 30 min is", async () => {
  const a = await wallet({ lastErrorAt: ago(2 * min), lastError: "NETWORK", errorStreak: 1, lastOkAt: ago(5 * min) });
  assert.equal(a.walletSyncFailing, false);
  resetState();
  const b = await wallet({ lastErrorAt: ago(2 * min), lastError: "NETWORK", errorStreak: 5, lastOkAt: ago(10 * min) });
  assert.equal(b.walletSyncFailing, false, "last success is recent");
  resetState();
  const c = await wallet({ lastErrorAt: ago(2 * min), lastError: "NETWORK", errorStreak: 5, lastOkAt: ago(90 * min) });
  assert.equal(c.walletSyncFailing, true);
  assert.equal(c.walletSyncError, "NETWORK");
  resetState();
  const d = await wallet({ lastErrorAt: ago(2 * min), lastError: "HTTP_401", errorStreak: 3 });
  assert.equal(d.walletSyncFailing, true, "never succeeded + streak");
  resetState();
  const e = await wallet({ lastErrorAt: ago(8 * 60 * min), lastError: "NETWORK", errorStreak: 9, lastOkAt: ago(9 * 60 * min) });
  assert.equal(e.walletSyncFailing, false, "old error: not current");
});

test("U2. the alert text says what happened, what it affects and what to do — per cause — and leaks nothing", () => {
  for (const code of ["NETWORK", "HTTP_401", "HTTP_429", "HTTP_503", "BAD_RESPONSE", "WEIRD_CODE"]) {
    const t = Ops.walletSyncText(code);
    assert.match(t, /علت:/); assert.match(t, /اثر:/); assert.match(t, /کار لازم:/);
    assert.match(t, /چیزی گم نمی‌شود/);
    assert.doesNotMatch(t, /mongodb|SECRET=|token/i);
  }
  assert.match(Ops.walletSyncText("HTTP_401"), /WALLET_INTEGRATION_ID/);
  assert.match(Ops.walletSyncText("NETWORK"), /timeout/);
});

test("U4. jeton menu = reply keyboard (4 options + panel back); each option starts its step with the red cancel keyboard", async () => {
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  await h.text(OWNER_ID, "🪙 مدیریت ژتون");
  const menu = h.of("sendMessage", OWNER_ID).at(-1)!;
  assert.equal(menu.payload.reply_markup.inline_keyboard, undefined);
  assert.equal(menu.payload.reply_markup.keyboard.flat().length, 5);
  h.resetCalls();
  await h.text(OWNER_ID, "😴 ارسال به کم‌فعالیت‌ها");
  const p = h.of("sendMessage", OWNER_ID).at(-1)!;
  assert.deepEqual(p.payload.reply_markup.keyboard.flat().map((b: any) => b.text), ["❌ لغو"]);
  assert.equal(p.payload.reply_markup.keyboard[0][0].style, "danger");
  h.resetCalls();
  await h.text(OWNER_ID, "❌ لغو");
  assert.ok(h.of("sendMessage", OWNER_ID).some((c) => /لغو شد/.test(String(c.payload.text))));
  h.resetCalls();
  await h.text(OWNER_ID, "➕➖ تعدیل دستی یک کاربر");
  assert.equal(h.of("sendMessage", OWNER_ID).at(-1)!.payload.reply_markup.keyboard[0][0].text, "❌ لغو");
});

test("U5. non-owner cannot use the new jeton option labels", async () => {
  seedUser({ id: 901, anonId: "user_A901", nickname: "ادمین", isAdmin: true } as any);
  h.resetCalls();
  await h.text(901, "😴 ارسال به کم‌فعالیت‌ها");
  assert.equal(col("admin_flow_state").all().length, 0);
});

test("U6. user list: every row is a glass button that opens the profile; banned users get «آن‌بن» only", async () => {
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  seedUser({ id: 31, anonId: "user_C0031", nickname: "علی" });
  seedUser({ id: 32, anonId: "user_C0032", nickname: "رضا", banned: true } as any);
  await h.text(OWNER_ID, "👥 لیست کاربران");
  const list = h.of("sendMessage", OWNER_ID).filter((c) => /کاربران \(صفحه/.test(String(c.payload.text))).at(-1)!;
  const btns = list.payload.reply_markup.inline_keyboard.flat();
  const v32 = btns.find((b: any) => b.callback_data === "admin:user:view:32");
  assert.ok(v32 && /رضا/.test(v32.text) && v32.style === "danger");
  assert.ok(btns.some((b: any) => b.callback_data === "admin:user:view:31"));
  h.resetCalls();
  await h.callback(OWNER_ID, "admin:user:view:32");
  const card = h.of("sendMessage", OWNER_ID).filter((c) => /پروفایل کامل/.test(String(c.payload.text))).at(-1)!;
  const cb = card.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(cb.includes("admin:user:unban:32") && !cb.includes("admin:user:ban:32"));
  h.resetCalls();
  await h.callback(OWNER_ID, "admin:user:view:31");
  const cb2 = h.of("sendMessage", OWNER_ID).filter((c) => /پروفایل کامل/.test(String(c.payload.text))).at(-1)!.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.ok(cb2.includes("admin:user:ban:31") && !cb2.includes("admin:user:unban:31"));
});

test("U7. a non-admin cannot open a profile through the new view callback", async () => {
  seedUser({ id: 41, anonId: "user_C0041", nickname: "کاربر" });
  seedUser({ id: 42, anonId: "user_C0042", nickname: "دیگر" });
  h.resetCalls();
  await h.callback(41, "admin:user:view:42");
  assert.equal(h.of("sendMessage", 41).filter((c) => /پروفایل کامل/.test(String(c.payload.text))).length, 0);
});

test("U8. channel list: each toggle button carries the channel's name", async () => {
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  const { addChannel } = await import("../../src/db/models/channel.js");
  await addChannel({ title: "کانال نوا", chatRef: "@navaone", url: "https://t.me/navaone", handle: "@navaone" });
  await addChannel({ title: "کانال دو", chatRef: "@navatwo", url: "https://t.me/navatwo", handle: "@navatwo" });
  await h.callback(OWNER_ID, "admin:channels");
  const m = h.of("sendMessage", OWNER_ID).filter((c) => /کانال‌های جوین/.test(String(c.payload.text))).at(-1)!;
  const texts = m.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
  assert.ok(texts.some((t: string) => t.includes("کانال نوا")) && texts.some((t: string) => t.includes("کانال دو")));
});

test("U9. official-account and badge prompts show the red cancel button", async () => {
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  await h.text(OWNER_ID, "🏛 ساخت اکانت حقوقی");
  assert.equal(h.of("sendMessage", OWNER_ID).at(-1)!.payload.reply_markup.keyboard[0][0].text, "❌ لغو");
  await h.text(OWNER_ID, "❌ لغو");
  h.resetCalls();
  await h.text(OWNER_ID, "🏅 بج‌ها");
  assert.equal(h.of("sendMessage", OWNER_ID).at(-1)!.payload.reply_markup.keyboard[0][0].text, "❌ لغو");
});
