/** v1.31.1 — emoji syntax, owner security, channel refs, broadcast preview + report, coded errors. (MOCK Mongo/Telegram) The «طراحی داخلی ربات» hub was removed at the owner's request. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ PREMIUM_EMOJI_ENABLED: "true" });
const syn = await import("../../src/services/emojiSyntax.js");
const { setEmojiOverrides } = await import("../../src/config/emojis.js");
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
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "Owner", age: 30, province: "تهران", city: "تهران", gender: "male", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: USER, anonId: "user_USR", nickname: "Sara", age: 25, province: "تهران", city: "تهران", gender: "female", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

test("D1. emoji syntax: premium only when switch ON and owner has Premium; Enter stays a newline", () => {
  const raw = `سلام -😌 -${ID}-\nخط دوم`;
  assert.equal(syn.emojiSyntaxToHtml(raw, { premium: true }), `سلام <tg-emoji emoji-id="${ID}">😌</tg-emoji>\nخط دوم`);
  assert.equal(syn.emojiSyntaxToHtml(raw, { premium: false }), "سلام 😌\nخط دوم");
  assert.equal(syn.premiumUsable(), true);
  syn.setOwnerPremium(false);
  assert.equal(syn.premiumUsable(), false, "owner without Premium → simple emoji");
  syn.setOwnerPremium(true);
  assert.equal(syn.emojiSyntaxToHtml("a <b> & c"), "a &lt;b&gt; &amp; c");
});

test("D3. owner security: /admin /panel /owner give a normal user nothing; the panel never names the owner", async () => {
  for (const c of ["/admin", "/panel", "/owner", "/monitor"]) {
    h.resetCalls();
    await h.text(USER, c);
    const all = JSON.stringify(h.of("sendMessage", USER));
    assert.ok(!/پنل مدیریت|طراحی داخلی|مالک/.test(all), c);
    assert.ok(!all.includes("user_OWN"), c);
  }
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
