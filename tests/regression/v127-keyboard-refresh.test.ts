/** v1.27.0 — after a release the user's OLD reply keyboard is replaced automatically on their next tap/message (no /start needed). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ OWNER_ID: "1" });
const { KEYBOARD_REV } = await import("../../src/config/version.js");

const user = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_K${String(id).padStart(5, "0")}`, nickname: "k" + id, age: 25, gender: "female", province: "تهران", city: "تهران", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED", lastActivityAt: new Date(), ...extra } as any);
const refreshes = (id: number) => h.of("sendMessage", id).filter((c) => String(c.payload.text).includes("منوت هم تازه شد"));

beforeEach(() => { resetState(); h.resetCalls(); user(5); user(6); });

test("K1. a keyboard from an older release is refreshed once, silently, on the next message", async () => {
  await col("kb_state").insertOne({ _id: 5, kind: "main", rev: "1.0-old", at: new Date() } as any);
  await h.text(5, "یه چیز نامربوط");
  await h.settle();
  const r = refreshes(5);
  assert.equal(r.length, 1);
  assert.ok(Array.isArray(r[0]!.payload.reply_markup.keyboard));
  assert.equal(r[0]!.payload.disable_notification, true);
  assert.equal(((await col("kb_state").findOne({ _id: 5 })) as any).rev, KEYBOARD_REV);
  h.resetCalls();
  await h.text(5, "باز یه چیز نامربوط");
  await h.settle();
  assert.equal(refreshes(5).length, 0, "only once per keyboard revision");
});

test("K2. a user who is already on the current revision gets nothing", async () => {
  await col("kb_state").insertOne({ _id: 6, kind: "main", rev: KEYBOARD_REV, at: new Date() } as any);
  await h.text(6, "یه چیز نامربوط");
  await h.settle();
  assert.equal(refreshes(6).length, 0);
});

test("K3. an old inline button (no handler) answers with a hint instead of a silent spinner", async () => {
  await col("kb_state").insertOne({ _id: 5, kind: "main", rev: KEYBOARD_REV, at: new Date() } as any);
  await h.callback(5, "legacy:button:gone");
  await h.settle();
  const a = h.of("answerCallbackQuery");
  assert.ok(a.some((c) => String(c.payload.text ?? "").includes("قدیمی")), JSON.stringify(a.map((c) => c.payload)));
});

test("K4. an admin with no recorded keyboard who taps a panel button gets the ADMIN panel back, not the user menu", async () => {
  user(900, { isAdmin: true });
  await h.text(900, "📝 متن‌ها");
  await h.settle();
  const r = refreshes(900);
  assert.equal(r.length, 1);
  const labels = r[0]!.payload.reply_markup.keyboard.flat().map((b: any) => String(b.text));
  assert.ok(labels.includes("⚙️ تنظیمات ربات"), labels.join("|"));
});
