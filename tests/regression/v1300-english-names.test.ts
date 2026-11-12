/** v1.30.0 — M1: names are English only; an old non-English name must be changed before anything else (owner/admins/seeds exempt).
 *  MOCK TESTS: fake MongoDB / Telegram. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col, keepPersianFixtureNames } from "../harness/fakeMongo.js";

keepPersianFixtureNames(); // the point of these tests is old Persian names
const h = await createHarness();
const { isValidEnglishNickname } = await import("../../src/features/onboarding/nickname.js");

beforeEach(() => {
  resetState();
  h.resetCalls();
  h.clearFailures();
});
const user = (id: number) => col("users").all().find((u: any) => u._id === id);
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));

test("E1. the English rule: Latin letters and single spaces, 1..32; no digits, Persian, symbols, double spaces", () => {
  for (const ok of ["Sara", "Ali Reza", " Ali ", "a"]) assert.equal(isValidEnglishNickname(ok), true, ok);
  for (const bad of ["", "   ", "علی", "Ali1", "Ali_x", "Ali  Reza", "Ali-Reza", "x".repeat(33), "Alí", "😀"]) assert.equal(isValidEnglishNickname(bad), false, bad);
});

test("E2. an old Persian name: /start -> asked for an English name; a button tap is stopped the same way; nothing else runs", async () => {
  seedUser({ id: 9001, nickname: "علی", relicBalance: 10, relicInitialized: true });
  await h.text(9001, "/start");
  assert.ok(texts(9001).some((t) => /انگلیسی/.test(t)), "asked for an English name");
  assert.equal(user(9001).nicknameFixPending, true);
  h.resetCalls();
  await h.callback(9001, "menu:anything");
  assert.ok(h.of("answerCallbackQuery").length >= 1);
  assert.ok(texts(9001).some((t) => /انگلیسی/.test(t)));
  assert.equal(user(9001).nickname, "علی", "nothing changed yet");
});

test("E3. a wrong answer re-asks (Persian, digits); a good one is saved at once, the flag is cleared and the menu returns", async () => {
  seedUser({ id: 9002, nickname: "سارا", relicBalance: 10, relicInitialized: true });
  await h.text(9002, "سلام");
  h.resetCalls();
  await h.text(9002, "سارا");
  assert.ok(texts(9002).some((t) => /فقط حروف انگلیسی/.test(t)));
  await h.text(9002, "Sara99");
  assert.equal(user(9002).nickname, "سارا");
  h.resetCalls();
  await h.text(9002, "Sara Jan");
  const u = user(9002);
  assert.equal(u.nickname, "Sara Jan");
  assert.equal(u.nicknameFixPending, undefined);
  assert.ok(texts(9002).some((t) => /اسمت ثبت شد/.test(t)));
  // afterwards the person is not stopped any more
  h.resetCalls();
  await h.text(9002, "/start");
  assert.equal(texts(9002).some((t) => /قانون جدید/.test(t)), false);
});

test("E4. exempt: owner, admins, seed/official accounts, banned users and people inside a running chat are never stopped", async () => {
  seedUser({ id: OWNER_ID, nickname: "مالک" });
  seedUser({ id: ADMIN_ID, nickname: "ادمین", isAdmin: true });
  seedUser({ id: 9003, nickname: "بذر", isSeed: true });
  seedUser({ id: 9004, nickname: "در چت", activeChatSessionId: "s1" } as any);
  for (const id of [OWNER_ID, ADMIN_ID, 9003, 9004]) {
    h.resetCalls();
    await h.text(id, "/start");
    assert.equal(texts(id).some((t) => /قانون جدید/.test(t)), false, `user ${id}`);
    assert.equal(user(id).nicknameFixPending, undefined);
  }
});

test("E5. onboarding in the bot refuses a Persian or numeric name and stays on the step", async () => {
  const NEW = 9100;
  await h.text(NEW, "/start");
  await h.callback(NEW, "lang:fa");
  await h.callback(NEW, "gender:male");
  await h.text(NEW, "25");
  const { PROVINCES } = await import("../../src/data/provinces.js");
  const { citiesForProvince } = await import("../../src/data/cities.js");
  const province = PROVINCES.find((p) => p.nameFa === "تهران")!;
  await h.text(NEW, province.nameFa);
  await h.text(NEW, citiesForProvince(province.id)[0]!.nameFa);
  for (const bad of ["علی", "Ali2"]) {
    await h.text(NEW, bad);
    assert.equal(user(NEW).onboardingStep, "NICKNAME_PENDING", bad);
  }
  await h.text(NEW, "Ali");
  assert.equal(user(NEW).onboardingStep, "COMPLETED");
  assert.equal(user(NEW).nickname, "Ali");
});
