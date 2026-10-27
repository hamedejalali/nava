/** v1.20.0 — reset user removes the person everywhere (bot + mini-app) and frees his username. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { checkUsername } = await import("../../src/services/miniappSocial.js");

beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "owner", relicBalance: 0, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", age: 22, bio: "hi", relicBalance: 50, relicInitialized: true, onboardingStep: "COMPLETED", miniUsername: "sarahh", miniUsernameLower: "sarahh", isPrivate: true } as any);
  seedUser({ id: 3, anonId: "user_AAA3", nickname: "نیما", relicBalance: 5, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("R1. reset wipes the profile, the mini-app username (freed at once), posts/follows/gifts/notifications — and leaves others alone", async () => {
  col("mini_posts").seed({ _id: "p1", ownerId: 2, createdAt: new Date() } as any);
  col("mini_posts").seed({ _id: "p2", ownerId: 3, createdAt: new Date() } as any);
  col("mini_follows").seed({ _id: "3:2", followerId: 3, followeeId: 2 } as any);
  col("mini_follows").seed({ _id: "2:3", followerId: 2, followeeId: 3 } as any);
  col("mini_gifts").seed({ _id: "g1", pub: "P1", receiverId: 2, senderId: 3, giftId: "rose" } as any);
  col("mini_gifts").seed({ _id: "g2", pub: "P2", receiverId: 3, senderId: 2, giftId: "rose" } as any);
  col("mini_notifs").seed({ _id: "n1", userId: 2, actorId: 3, at: new Date() } as any);

  assert.equal((await checkUsername({ _id: 3 } as any, "sarahh", false)).available, false, "taken before the reset");
  await h.callback(OWNER_ID, "admin:resetuser:confirm:2");

  const u = col("users").byId(2);
  assert.equal(u.onboardingStep, "LANGUAGE_PENDING");
  assert.equal(u.relicBalance, 0);
  for (const f of ["miniUsername", "miniUsernameLower", "isPrivate", "bio", "age", "nickname"]) assert.equal(u[f], undefined, f);
  assert.deepEqual(col("mini_posts").all().map((p: any) => p._id), ["p2"]);
  assert.deepEqual(col("mini_follows").all(), []);
  assert.deepEqual(col("mini_gifts").all().map((g: any) => g._id), ["g2"], "gifts he gave stay with their receivers");
  assert.equal(col("mini_notifs").all().length, 0);
  assert.equal((await checkUsername({ _id: 3 } as any, "sarahh", false)).available, true, "username is free again");
  assert.equal(col("users").byId(3).relicBalance, 5, "other users untouched");
});

test("R2. only the owner can reset", async () => {
  await h.callback(3, "admin:resetuser:confirm:2");
  assert.equal(col("users").byId(2).miniUsername, "sarahh");
});

test("P1. admin panel (v1.27): wallet / reaction gate live inside «⚙️ تنظیمات ربات»; wallet panel is owner-only", async () => {
  await h.text(OWNER_ID, "/start");
  const kb = JSON.stringify(h.last("sendMessage", OWNER_ID)?.payload.reply_markup ?? {});
  assert.ok(kb.includes("⚙️ تنظیمات ربات") && !kb.includes("🔌 اتصال ولت") && !kb.includes("راهنما / کانال جوین"));
  await h.text(OWNER_ID, "⚙️ تنظیمات ربات");
  const kb2 = JSON.stringify(h.last("sendMessage", OWNER_ID)?.payload.reply_markup ?? {});
  for (const label of ["🎯 تنظیم گیت ری‌اکشن", "🔌 اتصال ولت", "📊 آمار ربات", "💾 داده‌ها", "🛡️ مدیریت و لاگ"]) assert.ok(kb2.includes(label), label);
  h.resetCalls();
  await h.text(OWNER_ID, "🔌 اتصال ولت");
  assert.match(String(h.last("sendMessage", OWNER_ID)?.payload.text), /اتصال ولت/);
  await h.callback(OWNER_ID, "admin:wallet:toggle");
  const { isWalletIntegrationEnabled } = await import("../../src/services/wallet/walletSettings.js");
  assert.equal(await isWalletIntegrationEnabled(), false);
  await h.callback(3, "admin:wallet:toggle");
  assert.equal(await isWalletIntegrationEnabled(), false, "a normal user cannot flip it");
});
