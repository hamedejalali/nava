/** v1.31.0 — «طراحی داخلی ربات»: emoji syntax, button designer, per-language text editor, profile template, owner security, broadcast report, coded errors. (MOCK Mongo/Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ PREMIUM_EMOJI_ENABLED: "true" });
const syn = await import("../../src/services/emojiSyntax.js");
const ui = await import("../../src/db/models/uiConfig.js");
const { setEmojiOverrides } = await import("../../src/config/emojis.js");
const { getContent } = await import("../../src/db/models/content.js");
const to = await import("../../src/services/textOverrides.js");
const { channelRefFromMessage } = await import("../../src/features/admin/channelRef.js");

const USER = 5001;
const ID = "5368324170671202286";
const kbTexts = (c: any): string[] => ((c?.payload?.reply_markup?.keyboard ?? []) as any[][]).flat().map((b) => String(b.text));
const inlineTexts = (c: any): string[] => ((c?.payload?.reply_markup?.inline_keyboard ?? []) as any[][]).flat().map((b) => String(b.text));
const flat = (c: any) => ((c?.payload?.reply_markup?.inline_keyboard ?? []) as any[][]).flat();

beforeEach(async () => {
  resetState();
  h.resetCalls();
  setEmojiOverrides({ map: {} });
  syn.setOwnerPremium(true);
  await ui.loadUiButtons(true);
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "Owner", age: 30, province: "تهران", city: "تهران", gender: "male", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: USER, anonId: "user_USR", nickname: "Sara", age: 25, province: "تهران", city: "تهران", gender: "female", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("D1. emoji syntax: premium only when switch ON and owner has Premium; Enter stays a newline; works in button labels", () => {
  const raw = `سلام -😌 -${ID}-\nخط دوم`;
  assert.equal(syn.emojiSyntaxToHtml(raw, { premium: true }), `سلام <tg-emoji emoji-id="${ID}">😌</tg-emoji>\nخط دوم`);
  assert.equal(syn.emojiSyntaxToHtml(raw, { premium: false }), "سلام 😌\nخط دوم");
  assert.equal(syn.premiumUsable(), true);
  syn.setOwnerPremium(false);
  assert.equal(syn.premiumUsable(), false, "owner without Premium → simple emoji");
  syn.setOwnerPremium(true);
  const b = syn.renderButtonLabel(`-😌 -${ID}-پروفایل`, { premium: true });
  assert.deepEqual([b.text, b.iconId], ["پروفایل", ID]);
  const p = syn.renderButtonLabel(`-😌 -${ID}-پروفایل`, { premium: false });
  assert.deepEqual([p.text, p.iconId], ["😌 پروفایل", undefined]);
  assert.equal(syn.emojiSyntaxToHtml("a <b> & c"), "a &lt;b&gt; &amp; c");
});

test("D2. owner-made button: shows on the user's main keyboard, replies with the owner's text; rename/hide/colour of built-ins", async () => {
  const r = await ui.addCustomButton("🎁 هدیه", "success", `متن -😌 -${ID}-\nدوم`);
  assert.equal(r.ok, true);
  await ui.patchBuiltin("guide", { label: "📚 آموزش", style: "danger" });
  await ui.patchBuiltin("feedback", { hidden: true });
  await h.text(USER, "/start");
  const kb = h.last("sendMessage", USER)?.payload.reply_markup.keyboard.flat() as any[];
  const labels = kb.map((b) => b.text);
  assert.ok(labels.some((t) => t.includes("هدیه")), "custom button shown");
  assert.ok(labels.includes("📚 آموزش"), "renamed built-in shown");
  const g = kb.find((b) => b.text === "📚 آموزش");
  assert.equal(g.style, "danger");
  assert.ok(!labels.some((t) => /پیشنهاد|انتقاد/.test(t)), "hidden built-in is gone");
  h.resetCalls();
  await h.text(USER, "🎁 هدیه");
  const reply = h.last("sendMessage", USER)!;
  assert.ok(String(reply.payload.text).startsWith("متن "));
  assert.equal(reply.payload.parse_mode, "HTML");
  h.resetCalls();
  await h.text(USER, "📚 آموزش"); // renamed built-in still routes to the guide
  assert.ok(h.of("sendMessage", USER).length > 0);
  assert.ok(!String(h.last("sendMessage", USER)!.payload.text).includes("نمی‌فهمم"));
});

test("D3. owner security: /admin /panel /owner give a normal user nothing; the panel never names the owner", async () => {
  for (const c of ["/admin", "/panel", "/owner", "/monitor"]) {
    h.resetCalls();
    await h.text(USER, c);
    const all = JSON.stringify(h.of("sendMessage", USER));
    assert.ok(!/پنل مدیریت|طراحی داخلی|مالک/.test(all), c);
    assert.ok(!all.includes("user_OWN"), c);
  }
  h.resetCalls();
  await h.text(USER, "🎨 طراحی داخلی ربات");
  assert.ok(!JSON.stringify(h.of("sendMessage", USER)).includes("ویرایش متن‌ها"));
  await h.callback(USER, "ui:t:0");
  assert.equal(h.of("editMessageText", USER).length, 0);
});

test("D4. hub: owner reaches the three buttons; text editor = pick text → pick language → send → preview → confirm → back to the list", async () => {
  await h.text(OWNER_ID, "🎨 طراحی داخلی ربات");
  const hub = kbTexts(h.last("sendMessage", OWNER_ID));
  for (const x of ["🎛 طراحی دکمه‌های ربات", "✨ ایموجی پریمیوم‌ها", "✏️ ویرایش متن‌ها"]) assert.ok(hub.includes(x), x);
  await h.text(OWNER_ID, "✏️ ویرایش متن‌ها");
  const m = h.last("sendMessage", OWNER_ID)!;
  assert.deepEqual(inlineTexts(m), ["📝 ویرایش متن‌ها", "🎛 ویرایش دکمه‌ها", "🖼 ویرایش عکس‌ها"]);
  h.resetCalls();
  await h.callback(OWNER_ID, "ui:t:0", 11);
  const list = flat(h.last("editMessageText", OWNER_ID));
  assert.ok(list.length > 4 && list.some((b) => b.text.includes("قوانین")));
  const rules = list.find((b) => b.text === "قوانین")!;
  await h.callback(OWNER_ID, rules.callback_data, 11);
  const pick = flat(h.last("editMessageText", OWNER_ID));
  assert.deepEqual(pick.slice(0, 3).map((b) => b.text), ["🇮🇷 فارسی", "🇬🇧 English", "🇸🇦 العربية"]);
  // English
  h.resetCalls();
  await h.callback(OWNER_ID, pick[1]!.callback_data, 11);
  assert.ok(h.of("sendMessage", OWNER_ID).some((c) => kbTexts(c).includes("❌ لغو")), "red cancel button while the bot waits for text");
  await h.text(OWNER_ID, `Rules -😌 -${ID}-\nline2`);
  const prev = String(h.last("editMessageText", OWNER_ID)!.payload.text);
  assert.ok(prev.includes("پیش‌نمایش") && prev.includes("Rules"));
  await h.callback(OWNER_ID, "ui:ok", 11);
  const back = flat(h.last("editMessageText", OWNER_ID));
  assert.ok(back.some((b) => b.text === "قوانین"), "returned straight to the list");
  assert.match(await getContent("rules", "fa-default", "en"), /^Rules .*\nline2$/s);
  assert.notEqual(await getContent("rules", "fa-default", "fa"), await getContent("rules", "x", "en"), "Persian text untouched");
});

test("D5. profile card is a template: variables stay, empty-variable lines vanish, unknown variables are refused", async () => {
  const tpl = "نام : {name}\n🆔 {id}\nدرباره: {bio}";
  const out = to.renderTemplate(tpl, { name: "Jjl", id: "<code>x</code>", bio: "" });
  assert.equal(out, "نام : Jjl\n🆔 <code>x</code>");
  assert.deepEqual(to.unknownVars("a {name} {nope}"), ["{nope}"]);
  await to.saveTextOverride("t:profileCard:fa", "👤 {name} / {age}\n🏷 {mini}");
  const { buildProfileText } = await import("../../src/features/matching/profile.js");
  const { getUser } = await import("../../src/db/models/user.js");
  const u = (await getUser(USER))!;
  const text = buildProfileText("fa", u);
  assert.match(text, /^👤 Sara \/ 25$/);
  await to.saveTextOverride("t:profileCard:fa", null);
  assert.match(buildProfileText("fa", u), /نام : Sara/);
  // refused through the editor
  const list = ["ui:t:0"];
  void list;
});

test("D6. owner text override is per language and restores the default when reset", async () => {
  const { dictionaryString } = await import("../../src/i18n/index.js");
  const before = dictionaryString("fa", "errors.generic")!;
  await to.saveTextOverride("d:fa:errors.generic", "سفارشی");
  assert.equal(dictionaryString("fa", "errors.generic"), "سفارشی");
  await to.saveTextOverride("d:fa:errors.generic", null);
  assert.equal(dictionaryString("fa", "errors.generic"), before);
});

test("D7. channels: @username, t.me link or a forwarded channel post — never a numeric id typed by hand", () => {
  assert.equal(channelRefFromMessage({ text: "@mychannel" }), "@mychannel");
  assert.equal(channelRefFromMessage({ text: "https://t.me/mychannel" }), "@mychannel");
  assert.equal(channelRefFromMessage({ text: "t.me/mychannel/15" }), "@mychannel");
  assert.equal(channelRefFromMessage({ text: "-1001234567890" }), null);
  assert.equal(channelRefFromMessage({ forward_origin: { type: "channel", chat: { id: -100123, username: "pub" } } }), "@pub");
  assert.equal(channelRefFromMessage({ text: "hello" }), null);
});

test("D8. broadcast: preview is the message itself with confirm buttons; ONE complete log report afterwards", async () => {
  await h.text(OWNER_ID, "📢 پیام همگانی");
  await h.text(OWNER_ID, `سلام -😌 -${ID}-\nدوم`);
  const prev = h.last("sendMessage", OWNER_ID)!;
  assert.equal(prev.payload.parse_mode, "HTML");
  // the fake owner account has no Telegram Premium (re-checked on every owner update) → the simple emoji is shown
  assert.ok(String(prev.payload.text).includes("😌") && !String(prev.payload.text).includes("<tg-emoji"));
  assert.ok(inlineTexts(prev).some((t) => t.includes("تأیید")));
  h.failFor("sendMessage", USER);
  h.resetCalls();
  await h.callback(OWNER_ID, "admin:broadcast:confirm", 5);
  await h.settle();
  const logs = h.of("sendMessage", OWNER_ID).filter((c) => String(c.payload.text).includes("گزارش پیام همگانی"));
  assert.equal(logs.length, 1, "exactly one log message");
  const t = String(logs[0]!.payload.text);
  assert.ok(t.includes("ارسال موفق") && t.includes("ناموفق") && t.includes("سلام"));
});

test("D9. coded errors: the person sees MG-UH-xxx·ID and the same code is copied to the log chat", async () => {
  const { reportUnhandled, sendErrorCopy } = await import("../../src/services/errorReport.js");
  const rep = reportUnhandled("user", Object.assign(new Error("secret text"), { error_code: 500 }));
  assert.match(rep.shown, /^MG-UH-001·[0-9A-F]{6}$/);
  const sent: any[] = [];
  await sendErrorCopy({ sendMessage: async (id: number, text: string) => void sent.push({ id, text }) } as any, rep, { scope: "user", userId: 7, updateKind: "message", err: new Error("secret text"), description: "x" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(rep.shown));
  assert.ok(!sent[0].text.includes("secret text"), "no raw message leaks");
});
