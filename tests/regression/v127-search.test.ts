/** v1.27.0 — in-bot «جستجوی کاربران» / «افراد نزدیک» + working profile buttons. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/", OWNER_ID: "1" });

const user = (id: number, name: string, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_S${String(id).padStart(5, "0")}`, nickname: name, age: 25, gender: "female", province: "تهران", city: "تهران", relicBalance: 100, relicInitialized: true, onboardingStep: "COMPLETED", lastActivityAt: new Date(), ...extra } as any);

const labels = (id: number) =>
  h.of("sendMessage", id).concat(h.of("editMessageText", id)).flatMap((c) => (c.payload.reply_markup?.inline_keyboard ?? []).flat()).map((b: any) => String(b.text));

beforeEach(() => {
  resetState();
  h.resetCalls();
  user(7, "علی", { gender: "male" });
  user(8, "سارا");
  user(9, "مریم", { city: "شیراز", province: "فارس" });
  user(10, "نرگس", { banned: true });
});

test("S1. «جستجوی کاربران» opens the in-bot menu (no «به‌زودی»)", async () => {
  await h.text(7, "جستجوی کاربران");
  await h.settle();
  const all = h.of("sendMessage", 7).map((c) => String(c.payload.text)).join("\n");
  assert.ok(!all.includes("به‌زودی"), all);
  assert.ok(all.includes("جستجوی کاربران"), all);
});

test("S2. search by nickname returns only visible users and the red cancel keyboard is the single prompt keyboard", async () => {
  await h.text(7, "جستجوی کاربران");
  await h.callback(7, "usr:q");
  await h.settle();
  const prompt = h.of("sendMessage", 7).at(-1)!;
  assert.equal(prompt.payload.reply_markup.keyboard.length, 1);
  assert.equal(prompt.payload.reply_markup.keyboard[0].length, 1);
  assert.ok(String(prompt.payload.reply_markup.keyboard[0][0].text).includes("لغو"));
  h.resetCalls();
  await h.text(7, "سارا");
  await h.settle();
  const l = labels(7).join("|");
  assert.ok(l.includes("سارا"), l);
  h.resetCalls();
  await h.text(7, "/start");
  await h.settle();
});

test("S3. a banned user never shows up", async () => {
  await h.text(7, "جستجوی کاربران");
  await h.callback(7, "usr:q");
  await h.text(7, "نرگس");
  await h.settle();
  assert.ok(!labels(7).join("|").includes("نرگس"));
});

test("S4. nearby: same city fallback without a location, distance order with one", async () => {
  await h.text(7, "افراد نزدیک");
  await h.settle();
  let l = labels(7).join("|");
  assert.ok(l.includes("سارا") && !l.includes("مریم"), l);
  resetState();
  h.resetCalls();
  user(7, "علی", { gender: "male", location: { lat: 35.7, lng: 51.4, updatedAt: new Date() } });
  user(8, "سارا", { location: { lat: 35.8, lng: 51.4, updatedAt: new Date() } });
  user(9, "مریم", { location: { lat: 29.6, lng: 52.5, updatedAt: new Date() } });
  await h.text(7, "افراد نزدیک");
  await h.settle();
  l = labels(7).join("|");
  assert.ok(l.indexOf("سارا") < l.indexOf("مریم"), l);
  assert.ok(l.includes("کیلومتر"), l);
});

test("S5. profile «درخواست چت» button works: confirm → request reaches the target", async () => {
  await h.text(7, "جستجوی کاربران");
  await h.callback(7, "usr:q");
  await h.text(7, "سارا");
  await h.callback(7, "usr:v:8");
  await h.settle();
  const kb = h.of("sendPhoto", 7).concat(h.of("sendMessage", 7)).flatMap((c) => (c.payload.reply_markup?.inline_keyboard ?? []).flat()) as any[];
  const chatBtn = kb.find((b) => String(b.callback_data).startsWith("profile:chat_request:8"));
  assert.ok(chatBtn, "button carries the target id");
  await h.callback(7, "profile:chat_request:8");
  await h.callback(7, "pcr:b:8");
  await h.settle();
  const toTarget = h.of("sendMessage", 8).concat(h.of("sendPhoto", 8));
  assert.ok(toTarget.some((c) => String(c.payload.text ?? c.payload.caption).includes("درخواست چت")));
});
