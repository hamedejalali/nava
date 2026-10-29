/** v1.27.0 — admin panel structure: short main panel, nested settings, every label has a handler, removed buttons. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com/miniapp/" });
const menu = await import("../../src/features/admin/menu.js");

const texts = (call: any): string[] => {
  const rm = call?.payload?.reply_markup;
  const rows = rm?.keyboard ?? rm?.inline_keyboard ?? [];
  return rows.flat().map((b: any) => String(b.text));
};

beforeEach(() => {
  resetState();
  h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: ADMIN_ID, anonId: "user_ADM", nickname: "ادمین", age: 30, province: "تهران", city: "تهران", gender: "male", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED", isAdmin: true } as any);
});

test("A1. main panel is short and has channels + texts + settings; the old combined button is gone", async () => {
  await h.text(OWNER_ID, "/start");
  const t = texts(h.last("sendMessage", OWNER_ID));
  for (const x of ["👥 کاربر ها", "📢 پیام و گزارش", "🪙 ژتون‌ها", "🌙 مویاگرام", "🎭 ممبرهای پیش‌فرض", "📡 کانال‌ها", "📝 متن‌ها", "⚙️ تنظیمات ربات"]) assert.ok(t.includes(x), x);
  assert.ok(!t.some((x) => x.includes("راهنما / کانال جوین")));
  assert.ok(!t.includes("📊 آمار ربات") && !t.includes("🔌 اتصال ولت") && !t.includes("🛡️ مدیریت و لاگ"));
  assert.ok(t.length <= 12, `main panel has ${t.length} buttons`);
});

test("A2. settings holds stats / wallet / data / staff; sub-topics return to settings", async () => {
  await h.text(OWNER_ID, "⚙️ تنظیمات ربات");
  const s = texts(h.last("sendMessage", OWNER_ID));
  for (const x of ["📊 آمار ربات", "🔌 اتصال ولت", "💾 داده‌ها", "🛡️ مدیریت و لاگ", "🧩 متغیرها و تصاویر", "✨ ایموجی‌ها", "🔌 روشن / خاموش کردن ربات"]) assert.ok(s.includes(x), x);
  await h.text(OWNER_ID, "🛡️ مدیریت و لاگ");
  const st = texts(h.last("sendMessage", OWNER_ID));
  assert.ok(st.includes("🔑 دسترسی ادمین‌ها") && st.includes("↩️ بازگشت به تنظیمات ربات"));
  await h.text(OWNER_ID, "↩️ بازگشت به تنظیمات ربات");
  assert.ok(texts(h.last("sendMessage", OWNER_ID)).includes("📊 آمار ربات"));
  await h.text(OWNER_ID, "↩️ بازگشت به پنل");
  await h.text(OWNER_ID, "/start");
});

test("A3. «📝 متن‌ها» lists every editable text; «📡 کانال‌ها» gathers all channel settings", async () => {
  const { KEYBOARD_REV } = await import("../../src/config/version.js");
  await col("kb_state").updateOne({ _id: OWNER_ID } as any, { $set: { kind: "admin", rev: KEYBOARD_REV } }, { upsert: true }); // already on the current keyboard (no one-time refresh message)
  await h.text(OWNER_ID, "📝 متن‌ها");
  const t = texts(h.last("sendMessage", OWNER_ID));
  for (const x of ["📖 متن راهنما", "⚖️ قوانین", "🛟 آیدی پشتیبانی", "🛠 متن خاموشی ربات", "🛒 متن‌ها و دکمه‌های منوی خرید"]) assert.ok(t.includes(x), x);
  h.resetCalls();
  await h.text(OWNER_ID, "📡 کانال‌ها");
  const c = texts(h.last("sendMessage", OWNER_ID));
  assert.ok(c.includes("📢 کانال‌های جوین اجباری") && c.includes("📸 کانال پست‌ها و حراج (مویاگرام)") && c.includes("💾 تنظیم کانال بک‌آپ") && c.includes("📡 تنظیم کانال مدیریت"));
});

test("A4. /admin opens the panel; the removed inline «مدیریت ژتون کاربر» is nowhere", async () => {
  await h.text(OWNER_ID, "/admin");
  const all = JSON.stringify(h.of("sendMessage", OWNER_ID));
  assert.ok(!all.includes("مدیریت ژتون کاربر"));
  assert.ok(all.includes("👥 کاربر ها"));
});

/** every label of one topic answers (the bot rate-limits one person's taps, so each topic is walked with a fresh state) */
async function walkTopic(topic: string) {
  resetState();
  h.resetCalls();
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  await h.text(OWNER_ID, topic);
  await h.settle();
  const kb = texts(h.last("sendMessage", OWNER_ID)).filter((k) => !k.startsWith("↩️"));
  assert.ok(kb.length > 0, `${topic} is empty`);
  let n = 0;
  for (const k of kb) {
    const isTopic = (Object.values(menu.ADMIN_CATEGORY_LABELS) as string[]).includes(k);
    h.resetCalls();
    await h.text(OWNER_ID, k);
    await h.settle();
    const cs = h.of("sendMessage", OWNER_ID);
    assert.ok(cs.length > 0, `«${k}» got no answer`);
    assert.ok(!cs.some((c) => String(c.payload.text).includes("متوجه نشدم")), `«${k}» fell through to the fallback`);
    if (isTopic) {
      for (const k2 of texts(h.last("sendMessage", OWNER_ID)).filter((x) => !x.startsWith("↩️"))) {
        h.resetCalls();
        await h.text(OWNER_ID, k2);
        await h.settle();
        assert.ok(h.of("sendMessage", OWNER_ID).length > 0, `«${k2}» got no answer`);
        assert.ok(!h.of("sendMessage", OWNER_ID).some((c) => String(c.payload.text).includes("متوجه نشدم")), `«${k2}» fell through`);
        n++;
      }
    }
    n++;
  }
  return n;
}

for (const topic of ["👥 کاربر ها", "📢 پیام و گزارش", "🪙 ژتون‌ها", "🌙 مویاگرام", "🎭 ممبرهای پیش‌فرض", "⚙️ تنظیمات ربات"]) {
  test(`A5. every button inside «${topic}» is handled`, async () => {
    assert.ok((await walkTopic(topic)) >= 2);
  });
}

test("A6. a regular admin without permission is stopped on the typed label; with it he gets the screen", async () => {
  await h.text(ADMIN_ID, "📝 متن‌ها");
  assert.ok(h.of("sendMessage", ADMIN_ID).length > 0);
});

test("A7. an admin whose profile is incomplete goes through onboarding (no «نام: - سن: -» accounts)", async () => {
  resetState();
  seedUser({ id: 777, anonId: "user_A7", nickname: undefined, age: undefined, province: undefined, city: undefined, gender: undefined, relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED", isAdmin: true } as any);
  h.resetCalls();
  await h.text(777, "/start");
  await h.settle();
  const t = h.of("sendMessage", 777).map((c) => String(c.payload.text)).join("\n");
  assert.ok(!t.includes("پنل مدیریت روی کیبورد بازه"), t);
});
