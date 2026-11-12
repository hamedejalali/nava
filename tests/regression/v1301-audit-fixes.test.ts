/** v1.30.1 — fixes from the v1.30.0 audit. MOCK TESTS: fake MongoDB / Telegram. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col, keepPersianFixtureNames } from "../harness/fakeMongo.js";

keepPersianFixtureNames();
const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/", BOT_USERNAME: "NavaTestBot" });
const { ensureInvite } = await import("../../src/services/games/invites.js");
beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); });
const user = (id: number) => col("users").all().find((u: any) => u._id === id);
const results = () => h.of("answerInlineQuery").at(-1)!.payload.results;

test("W1. typing «@bot » creates NO account and sends NO «new user» notice to the admins", async () => {
  seedUser({ id: ADMIN_ID, nickname: "Admin", isAdmin: true });
  await h.inline(8101, "");
  assert.equal(results().length, 1, "the list is still shown");
  assert.equal(user(8101), undefined, "no user document");
  assert.equal(h.of("sendMessage", ADMIN_ID).length, 0);
});

test("W2. inline: a banned user and a switched-off bot get an empty list (the owner still gets the list)", async () => {
  seedUser({ id: 8102, banned: true });
  await h.inline(8102, "");
  assert.equal(results().length, 0);
  await col("bot_settings").updateOne({ _id: "singleton" }, { $set: { maintenanceMode: true } }, { upsert: true });
  await h.inline(8103, "");
  assert.equal(results().length, 0, "maintenance");
  await h.inline(OWNER_ID, "");
  assert.equal(results().length, 1);
});

test("W3. invite age is written ONCE: a second / stale answer can not overwrite it (F-01 integrity)", async () => {
  seedUser({ id: 8104, nickname: "Sara", age: 20, onboardingStep: "LANGUAGE_PENDING", inviteFlow: { token: await ensureInvite(8199, "backgammon"), step: "AGE" } } as any);
  await h.text(8104, "35");
  assert.equal(user(8104).age, 20);
  assert.equal(user(8104).inviteFlow.step, "READY");
});

test("W4. invite name is only written while the account is unfinished; a finished account is not touched by a stale flow", async () => {
  seedUser({ id: 8105, nickname: "Done", age: 25, onboardingStep: "COMPLETED", inviteFlow: { token: "AAAAAAAAAAAAAAAA", step: "NAME" } } as any);
  await h.text(8105, "Hacker");
  assert.equal(user(8105).nickname, "Done");
  assert.equal(user(8105).inviteFlow, undefined, "stale flow cleared");
});

test("W5. the forced name change is a plain write: no per-user notice to the admins, the name changes, the flag is gone", async () => {
  seedUser({ id: ADMIN_ID, nickname: "Admin", isAdmin: true });
  seedUser({ id: 8106, nickname: "سارا", relicBalance: 10, relicInitialized: true });
  await h.text(8106, "سلام");
  h.resetCalls();
  await h.text(8106, "Sara Lee");
  assert.equal(user(8106).nickname, "Sara Lee");
  assert.equal(user(8106).nicknameFixPending, undefined);
  assert.equal(h.of("sendMessage", ADMIN_ID).length, 0);
  assert.equal(h.of("sendMessage", OWNER_ID).length, 0);
});

test("W6. the name gate sits behind the rate limiter (a flood of messages is cut off, not answered one by one)", async () => {
  seedUser({ id: 8107, nickname: "علی", relicBalance: 10, relicInitialized: true });
  for (let i = 0; i < 40; i++) await h.text(8107, "hi " + i);
  assert.ok(h.of("sendMessage", 8107).length < 40, "not one reply per message");
});
