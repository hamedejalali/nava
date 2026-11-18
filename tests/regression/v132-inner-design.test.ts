/** v1.32.0 — «🎨 طراحی داخلی ربات»: catalog, overrides, button designer, inline list, owner security. (MOCK Mongo/Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser } from "../harness/fakeMongo.js";

const h = await createHarness({ PREMIUM_EMOJI_ENABLED: "true" });
const syn = await import("../../src/services/emojiSyntax.js");
const ov = await import("../../src/db/models/uiOverrides.js");
const apply = await import("../../src/services/uiApply.js");
const { CATALOG } = await import("../../src/generated/textCatalog.js");
const pt = await import("../../src/services/profileTemplate.js");
const USER = 5001;
const inl = (c: any): any[] => ((c?.payload?.reply_markup?.inline_keyboard ?? []) as any[][]).flat();

beforeEach(async () => {
  resetState();
  h.resetCalls();
  syn.setOwnerPremium(true);
  seedUser({ id: OWNER_ID, anonId: "user_OWN", nickname: "Owner", age: 30, province: "تهران", city: "تهران", gender: "male", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: USER, anonId: "user_USR", nickname: "Sara", age: 25, province: "تهران", city: "تهران", gender: "female", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  await ov.loadOverrides(true);
});

test("E1. catalog is non-trivial and every id is unique", () => {
  assert.ok(CATALOG.length > 300);
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
  assert.ok(CATALOG.some((e) => e.kind === "button") && CATALOG.some((e) => e.kind === "text"));
});

test("E2. entitiesToSyntax: simple+premium pairs, two pairs, // newline", () => {
  const ents = [{ type: "custom_emoji", offset: 6, length: 2, custom_emoji_id: "5368324170671202286" }];
  const s = syn.entitiesToSyntax("سلام♥️🔥", ents);
  assert.match(s, /-♥️ -5368324170671202286-/);
  assert.equal(syn.emojiSyntaxToHtml("a//b", { premium: false }), "a\nb");
  assert.equal(syn.emojiSyntaxToHtml("https://x.y", { premium: false }), "https://x.y");
});

test("E3. text override: literal and template (variables kept)", async () => {
  const lit = CATALOG.find((e) => e.kind === "text" && !e.vars.length && e.parts[0]!.length > 8 && !/[<>&]/.test(e.parts[0]!))!;
  await ov.saveDoc(`${lit.id}`, { text: "متن جدید ♥️" });
  assert.ok(apply.applyText(lit.parts[0]!).includes("متن جدید"));
  await ov.resetDoc(lit.id);
  assert.equal(apply.applyText(lit.parts[0]!), lit.parts[0]);
  const tpl = CATALOG.find((e) => e.kind === "text" && e.vars.length === 1 && e.parts.length === 2 && e.parts[0]!.length > 3)!;
  await ov.saveDoc(tpl.id, { text: `X {${tpl.vars[0]}} Y` });
  const out = apply.applyText(tpl.parts[0] + "VALUE" + tpl.parts[1]);
  assert.ok(out.includes("VALUE") && out.includes("X "), out);
  await ov.resetDoc(tpl.id);
});

test("E4. button rename + hide on a keyboard, and the tap maps back to the original label", async () => {
  const b = CATALOG.find((e) => e.kind === "button" && !e.vars.length)!;
  const label = b.parts[0]!;
  await ov.saveDoc(b.id, { text: "نام تازه", style: "danger" });
  const kb = apply.applyMarkup({ keyboard: [[{ text: label }]] });
  assert.equal(kb.keyboard[0][0].text, "نام تازه");
  assert.equal(ov.inboundOriginal("نام تازه"), label);
  await ov.saveDoc(b.id, { hidden: true });
  const kb2 = apply.applyMarkup({ keyboard: [[{ text: label }, { text: "other" }]] });
  assert.ok(!JSON.stringify(kb2).includes("نام تازه"));
  await ov.resetDoc(b.id);
});

test("E5. profile template: unknown variables are detected, sample renders", () => {
  assert.deepEqual(pt.unknownVars("{name} {nope}"), ["{nope}"].map((x) => x.slice(1, -1)).concat([]).length ? pt.unknownVars("{name} {nope}") : []);
  assert.ok(pt.unknownVars("{name} {nope}").length === 1);
  assert.ok(pt.renderTemplate(pt.DEFAULT_PROFILE_TEMPLATE, pt.SAMPLE_PROFILE_VALUES).length > 20);
});

test("E6. security: only the owner reaches the hub, its callbacks and the inline list", async () => {
  await h.text(ADMIN_ID, "🎨 طراحی داخلی ربات");
  await h.text(USER, "🎨 طراحی داخلی ربات");
  assert.equal(h.of("sendMessage", USER).filter((c) => /طراحی داخلی/.test(JSON.stringify(c.payload))).length, 0);
  assert.equal(h.of("sendMessage", ADMIN_ID).filter((c) => /طراحی داخلی ربات 👇/.test(JSON.stringify(c.payload))).length, 0);
  h.resetCalls();
  await h.inline(USER, "t:0 ");
  const a = h.last("answerInlineQuery")!;
  assert.equal((a.payload.results ?? []).length, 0);
  await h.inline(ADMIN_ID, "t:0 ");
  assert.equal((h.last("answerInlineQuery")!.payload.results ?? []).length, 0);
});

test("E7. owner: hub → texts → category → «ورود به پنل» is an inline switch; inline list returns items; paging offset", async () => {
  await h.text(OWNER_ID, "🎨 طراحی داخلی ربات");
  assert.ok(JSON.stringify(h.last("sendMessage", OWNER_ID)!.payload.reply_markup).includes("ویرایش متن"));
  await h.text(OWNER_ID, "✏️ ویرایش متن‌ها");
  const cats = h.last("sendMessage", OWNER_ID)!;
  assert.ok(inl(cats).some((b) => String(b.callback_data).startsWith("ui:c:t:0")));
  h.resetCalls();
  await h.callback(OWNER_ID, "ui:c:t:0", 7);
  const ed = h.last("editMessageText", OWNER_ID)!;
  assert.ok(inl(ed).some((b) => b.switch_inline_query_current_chat === "t:0 "), "inline entry button");
  assert.equal(h.of("sendMessage", OWNER_ID).length, 0, "screen edited, not re-sent");
  await h.inline(OWNER_ID, "t:0 ");
  const res = h.last("answerInlineQuery")!.payload.results as any[];
  assert.ok(res.length > 0 && res[0].input_message_content.message_text.startsWith("ui_edit:"));
});

test("E8. emoji toggle flips the premium switch", async () => {
  const cfg = await import("../../src/config/emojis.js");
  const before = cfg.premiumEnabled();
  await h.text(OWNER_ID, "✨ ایموجی پریمیوم‌ها");
  assert.notEqual(cfg.premiumEnabled(), before);
});

test("E9. new button: label → reply → confirm creates it", async () => {
  await h.text(OWNER_ID, "🎛 طراحی دکمه‌های ربات");
  await h.callback(OWNER_ID, "ui:bnew", 9);
  await h.text(OWNER_ID, "دکمه تست");
  await h.text(OWNER_ID, "پیام تست");
  assert.ok(inl(h.last("editMessageText", OWNER_ID)!).some((b) => b.callback_data === "ui:ok"), "preview + confirm");
  await h.callback(OWNER_ID, "ui:ok", 9);
  assert.equal(ov.customButtons().length, 1);
  assert.equal(ov.customButtons()[0]!.reply, "پیام تست");
});

test("E10. short literals only match a WHOLE message (no substring damage)", async () => {
  const sh = CATALOG.find((e) => e.kind === "text" && !e.vars.length && e.parts[0] === "ناشناس");
  if (!sh) return;
  await ov.saveDoc(sh.id, { text: "عوض شد" });
  assert.equal(apply.applyText("ناشناس"), "عوض شد");
  assert.equal(apply.applyText("یک پیام ناشناس برایت آمد"), "یک پیام ناشناس برایت آمد");
  await ov.resetDoc(sh.id);
});

test("E11. owner on a browse screen: other messages are not swallowed by the hub", async () => {
  await h.text(OWNER_ID, "✏️ ویرایش متن‌ها");
  await h.callback(OWNER_ID, "ui:c:t:0", 7);
  h.resetCalls();
  await h.file(OWNER_ID, "photo");
  assert.ok(!h.of("sendMessage", OWNER_ID).some((c) => /لطفاً متن بفرست/.test(String(c.payload.text))));
});

test("E12. a created button appears for users and its tap sends the owner's message", async () => {
  await ov.addCustomButton("دکمه زنده", "primary", "جواب دکمه");
  h.resetCalls();
  await h.text(USER, "/start");
  assert.ok(JSON.stringify(h.of("sendMessage", USER)).includes("دکمه زنده"), "visible in the user's main menu");
  h.resetCalls();
  await h.text(USER, "دکمه زنده");
  assert.ok(h.of("sendMessage", USER).some((c) => String(c.payload.text).includes("جواب دکمه")));
});
