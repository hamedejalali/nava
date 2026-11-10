/** v1.29.0 — bulk jeton send (owner), photo/name without approval + «عدم تأیید», profile-post caption, badge sync */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const LOG = -100777;
const h = await createHarness({ MODERATION_LOG_CHAT_ID: String(LOG) });
const { JETON_PACE } = await import("../../src/services/jetonMass.js");
JETON_PACE.ms = 0;
const { editPost, deletePost } = await import("../../src/services/nava/posts.js");
const { cleanBadges } = await import("../../src/config/badges.js");

const DAY = 86_400_000;
beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "مالک" });
  seedUser({ id: 11, nickname: "قدیمی", relicBalance: 1, lastActivityAt: new Date(Date.now() - 30 * DAY) }); // male, inactive
  seedUser({ id: 12, nickname: "قدیمیه", relicBalance: 1, lastActivityAt: new Date(Date.now() - 20 * DAY) }); // female, inactive
  seedUser({ id: 13, nickname: "فعال", relicBalance: 1, lastActivityAt: new Date() }); // male, active
  seedUser({ id: 14, nickname: "بنشده", relicBalance: 1, banned: true, lastActivityAt: new Date(Date.now() - 40 * DAY) });
});

const bal = (id: number) => col("users").byId(id).relicBalance;
const textsTo = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));

const MENU_LABEL: Record<string, string> = { inactive: "😴 ارسال به کم‌فعالیت‌ها", gender: "👫 ارسال بر اساس جنسیت", users: "🎯 ارسال به کاربر مشخص" };
async function startFlow(button: string) {
  await h.text(OWNER_ID, "🪙 مدیریت ژتون");
  const menu = h.of("sendMessage", OWNER_ID).filter((c) => /مدیریت ژتون —/.test(String(c.payload.text))).at(-1)!;
  // v1.29.7: the options are REPLY-keyboard buttons (not an inline keyboard) and the panel's own back button is among them
  assert.equal(menu.payload.reply_markup.inline_keyboard, undefined);
  const labels = menu.payload.reply_markup.keyboard.flat().map((b: any) => b.text);
  for (const l of Object.values(MENU_LABEL)) assert.ok(labels.includes(l), l);
  assert.ok(labels.includes("➕➖ تعدیل دستی یک کاربر") && labels.includes("↩️ بازگشت به پنل"));
  await h.text(OWNER_ID, MENU_LABEL[button]!);
}

test("J1. inactive users: days → amount → message → (no 2nd) → confirm; only the chosen message, one log line", async () => {
  await startFlow("inactive");
  await h.text(OWNER_ID, "7");
  await h.text(OWNER_ID, "5");
  await h.text(OWNER_ID, "سلام، هدیه‌ی ما");
  await h.callback(OWNER_ID, "admin:relic:mass:skip2");
  const confirm = h.of("sendMessage", OWNER_ID).filter((c) => /خلاصه/.test(String(c.payload.text))).at(-1)!;
  assert.match(String(confirm.payload.text), /تعداد: 2 نفر/);
  await h.callback(OWNER_ID, "admin:relic:mass:confirm");
  assert.equal(bal(11), 6); assert.equal(bal(12), 6);
  assert.equal(bal(13), 1); assert.equal(bal(14), 1);
  assert.deepEqual(textsTo(11), ["سلام، هدیه‌ی ما"]);
  assert.deepEqual(textsTo(13), []);
  const logs = h.of("sendMessage", LOG);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]!.payload.text), /تعداد دریافت‌کننده: 2 نفر[\s\S]*به ازای هر نفر: 5 ژتون[\s\S]*مجموع ژتون ارسال‌شده: 10 ژتون/);
});

test("J2. by gender with TWO messages in order; nobody else gets anything", async () => {
  await startFlow("gender");
  await h.callback(OWNER_ID, "admin:relic:mass:g:female");
  await h.text(OWNER_ID, "3");
  await h.text(OWNER_ID, "پیام اول");
  await h.callback(OWNER_ID, "admin:relic:mass:add2");
  await h.text(OWNER_ID, "پیام دوم");
  await h.callback(OWNER_ID, "admin:relic:mass:confirm");
  assert.equal(bal(12), 4); // the only active female (id 12); owner excluded
  assert.deepEqual(textsTo(12), ["پیام اول", "پیام دوم"]);
  assert.equal(bal(11), 1); assert.equal(bal(13), 1);
  assert.equal(h.of("sendMessage", LOG).length, 1);
});

test("J3. specific users without any message; double tap on confirm credits once; cancel works", async () => {
  await startFlow("users");
  await h.text(OWNER_ID, "11 13\n99999");
  await h.text(OWNER_ID, "2");
  await h.callback(OWNER_ID, "admin:relic:mass:nomsg");
  await h.callback(OWNER_ID, "admin:relic:mass:confirm");
  await h.callback(OWNER_ID, "admin:relic:mass:confirm");
  assert.equal(bal(11), 3); assert.equal(bal(13), 3);
  assert.deepEqual(textsTo(11), []);
  assert.equal(col("jeton_jobs").all().length, 1);
  await startFlow("users");
  await h.text(OWNER_ID, "لغو");
  await h.text(OWNER_ID, "5");
  assert.equal(bal(11), 3);
});

test("J4. blocked user still gets the jeton; a resumed job never credits twice; non-owner admin cannot use the bulk menu", async () => {
  h.failFor("sendMessage", 11, "Forbidden: bot was blocked by the user");
  await startFlow("inactive");
  await h.text(OWNER_ID, "7"); await h.text(OWNER_ID, "4"); await h.text(OWNER_ID, "x");
  await h.callback(OWNER_ID, "admin:relic:mass:skip2");
  await h.callback(OWNER_ID, "admin:relic:mass:confirm");
  assert.equal(bal(11), 5);
  const job = col("jeton_jobs").all()[0];
  assert.equal(job.undelivered, 1);
  const { processJetonJob } = await import("../../src/services/jetonMass.js");
  await col("jeton_jobs").updateOne({ _id: job._id }, { $set: { cursorId: -1, done: false } }); // simulate a crash before the cursor was saved
  await processJetonJob(h.bot.api, col("jeton_jobs").all()[0]);
  assert.equal(bal(11), 5); assert.equal(bal(12), 5); // ledger id makes it exactly-once
  seedUser({ id: 901, isAdmin: true, nickname: "ادمین" });
  await h.callback(901, "admin:relic:mass:inactive");
  assert.equal(col("admin_flow_state").byId(901), undefined);
});

test("P1. photo is live at once; staff card has only «عدم تأیید»; pressing it removes the photo and tells the user", async () => {
  await h.file(13, "photo", "NEWPHOTO");
  await h.settle();
  assert.equal(col("users").byId(13).profilePhotoFileId, "NEWPHOTO");
  const card = h.of("sendPhoto").find((c) => c.payload.chat_id === LOG || c.payload.chat_id === OWNER_ID)!;
  const rows = card.payload.reply_markup.inline_keyboard.flat();
  assert.equal(rows.length, 1);
  assert.match(rows[0].callback_data, /^modimg:reject:/);
  await h.callback(OWNER_ID, rows[0].callback_data);
  assert.equal(col("users").byId(13).profilePhotoFileId, undefined);
  assert.match(textsTo(13).at(-1)!, /عدم رعایت قوانین/);
  const before = h.of("sendMessage", 13).length;
  await h.callback(OWNER_ID, rows[0].callback_data);
  assert.equal(h.of("sendMessage", 13).length, before); // second tap: no-op
});

test("P2. a newer photo is never removed by rejecting an older one", async () => {
  await h.file(13, "photo", "OLD"); await h.settle();
  const card = h.of("sendPhoto").find((c) => c.payload.photo === "OLD")!;
  await h.file(13, "photo", "NEW"); await h.settle();
  await h.callback(OWNER_ID, card.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(col("users").byId(13).profilePhotoFileId, "NEW");
});

test("C1. profile-post: caption can be set, post can never be deleted; a new photo clears the caption; other posts stay deletable", async () => {
  await col("users").updateOne({ _id: 13 }, { $set: { anonId: "user_AAA3", profilePhotoFileId: "PH" } });
  const me: any = col("users").byId(13);
  const r = await editPost(me, "pp:user_AAA3", { caption: "کپشن من" });
  assert.equal(r.caption, "کپشن من");
  assert.equal(col("users").byId(13).profilePostCaption, "کپشن من");
  await assert.rejects(editPost(me, "pp:user_AAA2", { caption: "x" }), (e: any) => e.code === "not_found");
  await assert.rejects(deletePost(me, "pp:user_AAA3"), (e: any) => e.code === "forbidden");
  await assert.rejects(deletePost(me, "pp:user_AAA3", { asStaff: true }), (e: any) => e.code === "forbidden");
  const { setProfilePhoto } = await import("../../src/db/models/user.js");
  await setProfilePhoto(13, "PH2");
  assert.equal(col("users").byId(13).profilePostCaption, undefined);
});

test("B1. badges: only known ids; the user's own pulse fingerprint changes when a badge is added", async () => {
  assert.deepEqual(cleanBadges(["tick-gold", "nope", "tick-gold", "m-sun"]), ["tick-gold", "m-sun"]);
  const src = (await import("node:fs")).readFileSync("api/miniapp.ts", "utf8");
  assert.match(src, /badges: 1/); // the pulse reads the badge list …
  assert.match(src, /cleanBadges\(u\?\.badges\)/); // … and puts it into the fingerprint
});
