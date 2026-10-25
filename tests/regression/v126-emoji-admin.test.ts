/** v1.26.0 — premium emoji master switch + per-emoji override from the admin panel. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ OWNER_ID: "1", PREMIUM_EMOJI_ENABLED: "true" });
const { setPremiumEnabled, setEmojiOverride } = await import("../../src/db/models/emojiConfig.js");
const { premiumId, premiumEnabled, buttonIcon, setEmojiOverrides } = await import("../../src/config/emojis.js");

beforeEach(() => {
  resetState();
  h.resetCalls();
  setEmojiOverrides({ map: {} });
  seedUser({ id: 1, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("E1. override gives a premium id; removing it falls back", async () => {
  assert.equal(premiumId("HOME"), undefined);
  assert.ok(await setEmojiOverride("HOME", "5416041192905265756 🏠"));
  assert.equal(premiumId("HOME"), "5416041192905265756");
  assert.equal(buttonIcon("HOME").fallback, "🏠");
  await setEmojiOverride("HOME", null);
  assert.equal(premiumId("HOME"), undefined);
});

test("E2. master switch from the panel beats the env default", async () => {
  await setEmojiOverride("HOME", "5416041192905265756");
  await setPremiumEnabled(false);
  assert.equal(premiumEnabled(), false);
  assert.equal(premiumId("HOME"), undefined);
  await setPremiumEnabled(true);
  assert.equal(premiumId("HOME"), "5416041192905265756");
});

test("E3. owner sees the panel; the toggle callback flips the switch", async () => {
  await h.text(1, "✨ ایموجی‌ها");
  await h.settle();
  assert.ok(h.of("sendMessage", 1).some((c) => /ایموجی‌ها/.test(c.payload.text)));
  await h.callback(1, "adm:emo:tg", 10);
  await h.settle();
  assert.equal(premiumEnabled(), false);
});
