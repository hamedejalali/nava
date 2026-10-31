/** v1.27.2 — maintenance allow-list as glass buttons (add / delete) + the profile-photo step keeps its red cancel keyboard. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const btns = (c: any) => (c?.payload?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => ({ t: String(b.text), d: String(b.callback_data) }));

beforeEach(() => {
  resetState(); h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 55, anonId: "user_T55", nickname: "تستر", username: "tester55", age: 25, gender: "male", province: "تهران", city: "تهران", relicBalance: 5, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("M1. add by @username and by id, shown as glass buttons; tapping one asks and deletes", async () => {
  await h.callback(OWNER_ID, "admin:settings:al_add");
  await h.text(OWNER_ID, "@tester55 777");
  const list = h.of("sendMessage", OWNER_ID).filter((c) => btns(c).some((b: any) => b.d.startsWith("admin:settings:al_ask:"))).at(-1)!;
  const b = btns(list);
  assert.ok(b.some((x: any) => x.t.includes("@tester55")), JSON.stringify(b));
  assert.ok(b.some((x: any) => x.d === "admin:settings:al_ask:777"));
  assert.ok(b.some((x: any) => x.d === "admin:settings:al_add"));
  await h.callback(OWNER_ID, "admin:settings:al_ask:777");
  assert.ok(btns(h.last("editMessageText", OWNER_ID)).some((x: any) => x.d === "admin:settings:al_rm:777"));
  await h.callback(OWNER_ID, "admin:settings:al_rm:777");
  const s: any = await col("bot_settings").findOne({ _id: "singleton" });
  assert.deepEqual(s.maintenanceAllowIds, [55]);
});

test("M2. unknown @username is reported and nothing is saved", async () => {
  await h.callback(OWNER_ID, "admin:settings:al_add");
  await h.text(OWNER_ID, "@nobody_here");
  assert.ok(h.of("sendMessage", OWNER_ID).some((c) => String(c.payload.text).includes("پیدا/معتبر نبودن")));
});

test("M3. «🖼 عکس پروفایل»: the prompt keeps the single red cancel keyboard (no «🏠 منوی اصلی» right after)", async () => {
  h.resetCalls();
  await h.callback(55, "profile:edit:photo");
  await h.settle();
  const sent = h.of("sendMessage", 55);
  assert.equal(sent.length, 1, sent.map((c) => c.payload.text).join(" | "));
  assert.ok(String(sent[0]!.payload.reply_markup.keyboard[0][0].text).includes("لغو"));
});
