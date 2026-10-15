/** "/start" and onboarding for ORDINARY (non-owner) users — end-to-end through the REAL bot
 *  (middleware chain + every handler) on the fake Mongo / fake Telegram harness. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const { fa } = await import("../../src/i18n/locales/fa.js");
const { PROVINCES } = await import("../../src/data/provinces.js");
const { citiesForProvince } = await import("../../src/data/cities.js");
const { addChannel } = await import("../../src/db/models/channel.js");

const NEW = 5001;
const NEW2 = 5002;
const province = PROVINCES.find((p) => p.nameFa === "تهران")!;
const city = citiesForProvince(province.id)[0]!;

beforeEach(() => {
  resetState();
  h.resetCalls();
  h.clearFailures();
});

const user = (id: number) => col("users").all().find((u: any) => u._id === id);
const texts = (chatId: number) => h.of("sendMessage", chatId).map((c) => String(c.payload.text));
const lastText = (chatId: number) => texts(chatId).at(-1) ?? "";

async function completeOnboarding(id: number) {
  await h.text(id, "/start");
  await h.callback(id, "lang:fa");
  await h.callback(id, "gender:male");
  await h.text(id, "25");
  await h.text(id, province.nameFa);
  await h.text(id, city.nameFa);
  await h.text(id, "علی");
}

test("1. owner sends /start -> admin welcome, no onboarding", async () => {
  await h.text(OWNER_ID, "/start");
  assert.ok(texts(OWNER_ID).some((t) => /مالک/.test(t)), "owner gets the owner welcome");
  assert.ok(!h.of("sendMessage", OWNER_ID).some((c) => JSON.stringify(c.payload.reply_markup ?? {}).includes("lang:")), "no language/onboarding screen for the owner");
  assert.equal(user(OWNER_ID).onboardingStep, "COMPLETED");
});

test("2. a brand-new non-owner sends /start -> record created + language screen (NOT silence, NOT admin panel)", async () => {
  await h.text(NEW, "/start");
  const u = user(NEW);
  assert.ok(u, "user record must be created");
  assert.equal(u.onboardingStep, "LANGUAGE_PENDING");
  assert.ok(/^user_[A-Za-z0-9]{6}$/.test(u.anonId));
  const welcome = h.of("sendMessage", NEW).at(-1)!;
  assert.ok(welcome, "the user must get an answer");
  const kb = welcome.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(kb, ["lang:fa", "lang:en", "lang:ar"]);
  assert.equal(h.of("sendMessage", NEW).length, 1);
  assert.equal(u.relicBalance, 5); // the one-time welcome Relic, exactly once
  assert.equal(col("relic_transactions").all().filter((t: any) => t.userId === NEW).length, 1);
});

test("3. an existing, fully registered non-owner sends /start -> main menu, nothing is reset", async () => {
  seedUser({ id: NEW, nickname: "قدیمی", languageCode: "fa", relicBalance: 40, relicInitialized: true });
  await h.text(NEW, "/start");
  assert.match(lastText(NEW), new RegExp(fa.onboarding.chooseFromMenu.slice(0, 8)));
  const u = user(NEW);
  assert.equal(u.onboardingStep, "COMPLETED");
  assert.equal(u.nickname, "قدیمی");
  assert.equal(u.relicBalance, 40);
});

test("4. a non-owner resumes an incomplete onboarding exactly where they stopped, for every step", async () => {
  await h.text(NEW, "/start");
  await h.callback(NEW, "lang:fa");
  assert.equal(user(NEW).onboardingStep, "GENDER_PENDING");
  h.resetCalls();
  await h.text(NEW, "/start"); // closed the chat and came back
  assert.equal(user(NEW).onboardingStep, "GENDER_PENDING");
  assert.ok(h.of("sendMessage", NEW).length + h.of("editMessageText", NEW).length >= 1, "gender question is shown again");
  await h.callback(NEW, "gender:female");
  assert.equal(user(NEW).onboardingStep, "AGE_PENDING");
  h.resetCalls();
  await h.text(NEW, "/start");
  assert.equal(user(NEW).onboardingStep, "AGE_PENDING");
  assert.ok(h.of("sendMessage", NEW).length >= 1);
  await h.text(NEW, "30");
  await h.text(NEW, "/start");
  assert.equal(user(NEW).onboardingStep, "AGE_DONE");
  await h.text(NEW, province.nameFa);
  await h.text(NEW, "/start");
  assert.equal(user(NEW).onboardingStep, "CITY_PENDING");
  await h.text(NEW, city.nameFa);
  await h.text(NEW, "/start");
  assert.equal(user(NEW).onboardingStep, "NICKNAME_PENDING");
});

test("5+6. language -> gender -> age -> province -> city -> nickname completes onboarding, rewards paid once", async () => {
  await completeOnboarding(NEW);
  const u = user(NEW);
  assert.equal(u.onboardingStep, "COMPLETED");
  assert.equal(u.languageCode, "fa");
  assert.equal(u.gender, "male");
  assert.equal(u.age, 25);
  assert.equal(u.province, province.id);
  assert.equal(u.nickname, "علی");
  assert.ok(u.relicBalance >= 5);
  const tx = col("relic_transactions").all().filter((t: any) => t.userId === NEW);
  assert.equal(new Set(tx.map((t: any) => t._id)).size, tx.length);
  assert.ok(lastText(NEW).length > 0);
  // the main menu works right after onboarding
  h.resetCalls();
  await h.text(NEW, fa.mainMenu.connectAnonymous);
  assert.ok(h.of("sendMessage", NEW).length >= 1);
});

test("5b. tapping the language button twice / a stale gender button never rewinds or corrupts the flow", async () => {
  await h.text(NEW, "/start");
  await h.callback(NEW, "lang:fa");
  await h.callback(NEW, "lang:en"); // stale language button after progress
  assert.equal(user(NEW).onboardingStep, "GENDER_PENDING");
  await h.callback(NEW, "gender:male");
  await h.callback(NEW, "gender:female"); // gender is permanent
  assert.equal(user(NEW).gender, "male");
  assert.equal(user(NEW).onboardingStep, "AGE_PENDING");
});

test("6b. invalid onboarding input is rejected without advancing (age / province / nickname)", async () => {
  await h.text(NEW, "/start");
  await h.callback(NEW, "lang:fa");
  await h.callback(NEW, "gender:male");
  await h.text(NEW, "abc");
  await h.text(NEW, "5");
  await h.text(NEW, "120");
  assert.equal(user(NEW).onboardingStep, "AGE_PENDING");
  await h.text(NEW, "۲۲"); // Persian digits are accepted
  assert.equal(user(NEW).age, 22);
  await h.text(NEW, "not a province");
  assert.equal(user(NEW).onboardingStep, "AGE_DONE");
  await h.text(NEW, province.nameFa);
  await h.text(NEW, "not a city");
  assert.equal(user(NEW).onboardingStep, "CITY_PENDING");
  await h.text(NEW, city.nameFa);
  await h.text(NEW, "ali123");
  assert.equal(user(NEW).onboardingStep, "NICKNAME_PENDING");
  await h.text(NEW, "x".repeat(40));
  assert.equal(user(NEW).onboardingStep, "NICKNAME_PENDING");
});

test("7. a non-owner who has NOT joined the required channel gets the membership prompt (not silence)", async () => {
  await addChannel({ title: "کانال", chatRef: "@navatest", url: "https://t.me/navatest", handle: "@navatest" });
  await completeOnboarding(NEW);
  // the channel member check says 'left'
  (h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
    if (method === "getChatMember" && payload.user_id === NEW) return { ok: true, result: { status: "left", user: { id: NEW, is_bot: false, first_name: "x" } } };
    return prev(method, payload);
  });
  h.resetCalls();
  await h.text(NEW, fa.mainMenu.connectAnonymous);
  const msg = h.of("sendMessage", NEW).at(-1)!;
  assert.ok(msg, "membership prompt expected");
  const urls = msg.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.url ?? b.callback_data);
  assert.ok(urls.includes("https://t.me/navatest"));
});

test("8. an eligible non-owner who joined the channel proceeds", async () => {
  await addChannel({ title: "کانال", chatRef: "@navatest2", url: "https://t.me/navatest2", handle: "@navatest2" });
  await completeOnboarding(NEW2);
  h.resetCalls();
  await h.text(NEW2, fa.mainMenu.connectAnonymous); // harness answers getChatMember = member
  const sent = h.of("sendMessage", NEW2).map((c) => JSON.stringify(c.payload.reply_markup ?? {}));
  assert.ok(sent.some((s) => s.includes("search:") || s.includes("partner") || s.includes("lucky") || s.length > 5));
  assert.ok(!texts(NEW2).some((t) => t.includes("@navatest2")), "no membership prompt for a member");
});

test("9. an exempt user (/Exempt) skips the channel check", async () => {
  await addChannel({ title: "کانال", chatRef: "@navatest3", url: "https://t.me/navatest3", handle: "@navatest3" });
  await completeOnboarding(NEW);
  await h.text(NEW, "/Exempt");
  assert.equal(user(NEW).channelsExempt, true);
  (h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
    if (method === "getChatMember") return { ok: true, result: { status: "left", user: { id: payload.user_id, is_bot: false, first_name: "x" } } };
    return prev(method, payload);
  });
  h.resetCalls();
  await h.text(NEW, fa.mainMenu.connectAnonymous);
  assert.ok(!texts(NEW).some((t) => t.includes("@navatest3")));
  assert.ok(h.of("sendMessage", NEW).length >= 1);
});

test("10. a banned user is denied (only the ban notice) and can not use /start to get back in", async () => {
  seedUser({ id: NEW, banned: true, banReason: "spam" });
  await h.text(NEW, "/start");
  assert.match(lastText(NEW), /مسدود/);
  assert.equal(h.of("sendMessage", NEW).length, 1);
  await h.text(NEW, fa.mainMenu.connectAnonymous);
  assert.ok(texts(NEW).every((t) => /مسدود/.test(t)));
});

test("11. an ordinary user can not use owner/admin commands or admin keyboard labels", async () => {
  await completeOnboarding(NEW);
  h.resetCalls();
  await h.text(NEW, "/admin");
  await h.text(NEW, "/monitor");
  const out = texts(NEW).join("\n");
  assert.ok(!/ادمین پنل|پنل مدیریت|مانیتور نوا/.test(out), "no admin/monitor content may be shown to an ordinary user");
  // the decisive checks: no admin keyboard was handed out, and no privileged state changed
  const adminKb = h.of("sendMessage", NEW).some((c) => JSON.stringify(c.payload.reply_markup ?? {}).includes("مدیریت کاربران"));
  assert.equal(adminKb, false);
  assert.ok(!user(NEW).isAdmin);
});

test("12. a legitimate admin keeps the permissions they were given (static ADMIN_IDS and DB-granted)", async () => {
  await h.text(ADMIN_ID, "/start");
  assert.ok(texts(ADMIN_ID).some((t) => /ادمین/.test(t)));
  seedUser({ id: NEW2, isAdmin: true });
  await h.text(NEW2, "/start");
  assert.ok(texts(NEW2).some((t) => /ادمین/.test(t)));
});

test("13. two users onboarding at the same time never share or corrupt each other's state", async () => {
  await Promise.all([h.text(NEW, "/start"), h.text(NEW2, "/start")]);
  await Promise.all([h.callback(NEW, "lang:fa"), h.callback(NEW2, "lang:fa")]);
  await Promise.all([h.callback(NEW, "gender:male"), h.callback(NEW2, "gender:female")]);
  await Promise.all([h.text(NEW, "21"), h.text(NEW2, "34")]);
  assert.equal(user(NEW).languageCode, "fa");
  assert.equal(user(NEW2).languageCode, "fa");
  assert.equal(user(NEW).gender, "male");
  assert.equal(user(NEW2).gender, "female");
  assert.equal(user(NEW).age, 21);
  assert.equal(user(NEW2).age, 34);
  assert.notEqual(user(NEW).anonId, user(NEW2).anonId);
});

test("14. duplicate /start updates (Telegram retry / double tap) create ONE user, ONE welcome Relic, ONE ledger row", async () => {
  await Promise.all([h.text(NEW, "/start", 1), h.text(NEW, "/start", 1), h.text(NEW, "/start", 1)]);
  assert.equal(col("users").all().filter((u: any) => u._id === NEW).length, 1);
  assert.equal(user(NEW).relicBalance, 5);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.userId === NEW).length, 1);
  assert.equal(col("users").all().filter((u: any) => u.anonId === user(NEW).anonId).length, 1);
});

test("15. a failing Telegram call or a MongoDB error does not silently corrupt onboarding (webhook gets an error -> Telegram retries)", async () => {
  // Telegram refuses to deliver the welcome (user blocked the bot / API error)
  h.failFor("sendMessage", NEW);
  await h.text(NEW, "/start").catch(() => {});
  assert.equal(user(NEW)?.onboardingStep, "LANGUAGE_PENDING"); // record exists, state is not advanced
  h.clearFailures();
  h.resetCalls();
  await h.text(NEW, "/start"); // the retry works and shows the welcome
  assert.ok(h.of("sendMessage", NEW).length >= 1);
  assert.equal(user(NEW).relicBalance, 5);
});

test("16. REGRESSION: choosing English/Arabic (wording not supplied yet) never dead-ends the user: alert + stay on language screen, language not saved", async () => {
  for (const lang of ["en", "ar"]) {
    resetState();
    h.resetCalls();
    await h.text(NEW, "/start");
    await h.callback(NEW, `lang:${lang}`); // used to throw MissingTranslationError -> webhook 500, user stuck
    assert.equal(user(NEW).onboardingStep, "LANGUAGE_PENDING");
    assert.equal(user(NEW).languageCode ?? "fa", "fa");
    const alert = h.of("answerCallbackQuery")[0];
    assert.ok(alert && alert.payload.show_alert, "user is told the language is not available yet");
    // and they can still finish with Persian
    await h.callback(NEW, "lang:fa");
    assert.equal(user(NEW).onboardingStep, "GENDER_PENDING");
  }
});

test("17. REGRESSION: a user already stuck on en/ar from before gets the language screen on /start and resumes at their stored step after picking fa", async () => {
  seedUser({ id: NEW, languageCode: "en", onboardingStep: "AGE_PENDING", gender: "male" });
  await h.text(NEW, "/start");
  const kb = h.of("sendMessage", NEW).at(-1)!.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert.deepEqual(kb, ["lang:fa", "lang:en", "lang:ar"]);
  await h.callback(NEW, "lang:fa");
  assert.equal(user(NEW).languageCode, "fa");
  assert.equal(user(NEW).onboardingStep, "AGE_PENDING"); // progress kept, not rewound
  await h.text(NEW, "27");
  assert.equal(user(NEW).age, 27);
});

test("18. REGRESSION: a concurrent first-insert race (E11000 on _id) is retried instead of failing the user's first /start", async () => {
  const users: any = col("users");
  const orig = users.findOneAndUpdate.bind(users);
  let boom = true;
  users.findOneAndUpdate = async (...a: any[]) => {
    if (boom) { boom = false; const e: any = new Error("E11000 duplicate key error collection: nava.users index: _id_ dup key: { _id: 5001 }"); e.code = 11000; throw e; }
    return orig(...a);
  };
  try {
    await h.text(NEW, "/start");
  } finally {
    users.findOneAndUpdate = orig;
  }
  assert.ok(user(NEW), "user created on the retry");
  assert.ok(h.of("sendMessage", NEW).length >= 1, "and answered");
});

test("19. REGRESSION: failing to load the admin list for the 'new user' notice never breaks (or crashes on) the new user's /start", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const settings: any = col("settings");
  const origFind = settings.find?.bind(settings);
  const adminUsers: any = col("users");
  const origFindUsers = adminUsers.find.bind(adminUsers);
  let calls = 0;
  adminUsers.find = (...a: any[]) => { calls++; if (calls <= 1) throw new Error("simulated DB hiccup"); return origFindUsers(...a); };
  try {
    await h.text(NEW, "/start");
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    adminUsers.find = origFindUsers;
    if (origFind) settings.find = origFind;
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled.length, 0, "no unhandled rejection");
  assert.ok(h.of("sendMessage", NEW).length >= 1, "the user still gets the welcome screen");
});
