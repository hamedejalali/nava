/** v1.29.6 — (a) a stale lease holder can no longer create a second prompt / overwrite a newer flow (atomic completion),
 *  (b) old v1.29.3 buttons that still carry the sender's Telegram id are upgraded lazily, (c) lease > webhook maxDuration.
 *  MOCK TESTS: fake MongoDB + fake Telegram. They prove application logic and ordering, NOT real MongoDB transactions or Telegram behaviour. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const am = await import("../../src/db/models/anonMessages.js");
const { setPendingTarget, claimPendingTarget, completePendingWithFlow, isLegacyExposedId, PENDING_LEASE_MS } = am;
const { resumePendingAnon } = await import("../../src/features/anonMessages/index.js");
const { addChannel } = await import("../../src/db/models/channel.js");

const mk = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_C${String(id % 100000).padStart(5, "0")}`, nickname: `N${id}`, age: 25, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED", ...extra } as never);
const flows = () => col("anon_msg_flow").all();
const pendings = () => col("anon_pending_target").all();
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));
const composePrompts = (id: number) => texts(id).filter((t) => t.includes("پیامت رو بنویس")).length;
const answers = () => h.of("answerCallbackQuery").map((c) => String(c.payload.text ?? ""));
const keyboardData = (c: { payload: any }) => (c.payload.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => String(b.callback_data ?? ""));

const joined = { v: true };
(h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
  if (method === "getChatMember" && payload.__hook) await payload.__hook();
  return prev(method, payload);
});
beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); joined.v = true; });

const ctxFor = (id: number) => ({ from: { id }, chat: { id }, api: h.bot.api, dbUser: {}, userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(id, t, o) }) as any;

/* ----------------------------------------------------------- (a) stale lease holder */
test("Y1. completePendingWithFlow: only the CURRENT lease holder removes the link and writes the flow", async () => {
  mk(2); mk(100);
  await setPendingTarget(100, 2);
  const a = await claimPendingTarget(100);
  assert.ok(a);
  await col("anon_pending_target").updateOne({ _id: 100 }, { $set: { claimUntil: 1 } }); // A's lease ran out ...
  const b = await claimPendingTarget(100); // ... and B took over
  assert.ok(b && b.token !== a!.token);
  assert.equal(await completePendingWithFlow(100, a!.token, { _id: 100, stage: "compose", targetId: 2 }), false, "stale holder: refused");
  assert.equal(flows().length, 0, "the stale holder wrote nothing");
  assert.equal(pendings().length, 1, "the link is still there for the real holder");
  assert.equal(await completePendingWithFlow(100, b!.token, { _id: 100, stage: "compose", targetId: 2 }), true);
  assert.equal(flows().length, 1);
  assert.equal(pendings().length, 0);
  assert.equal(await completePendingWithFlow(100, b!.token, { _id: 100, stage: "compose", targetId: 2 }), false, "a second completion does nothing");
});

test("Y2. worker A is slow (join check); meanwhile the user opens ANOTHER link: A neither overwrites the newer state nor sends a prompt", async () => {
  mk(2); mk(3); mk(100);
  await addChannel({ title: "کانال", chatRef: "@navatestz", url: "https://t.me/navatestz", handle: "@navatestz" });
  await setPendingTarget(100, 2);
  // the hook runs inside A's getChatMember call: the user re-opens a link to person 3 (the direct path resets the lease / token)
  const orig = h.bot.api.config;
  void orig;
  let hooked = false;
  (h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
    if (method === "getChatMember" && !hooked) { hooked = true; await setPendingTarget(100, 3); }
    return prev(method, payload);
  });
  await resumePendingAnon(ctxFor(100));
  assert.equal(hooked, true, "the interleaving really happened");
  assert.equal(composePrompts(100), 0, "stale worker: no prompt");
  assert.equal(flows().length, 0, "stale worker: no flow");
  assert.equal(pendings().length, 1);
  assert.equal(pendings()[0]!.targetId, 3, "the NEWER link survived untouched");
});

test("Y3. normal single worker: still exactly one flow and one prompt (no regression of v1.29.4 behaviour)", async () => {
  mk(2); mk(100);
  await setPendingTarget(100, 2);
  await resumePendingAnon(ctxFor(100));
  assert.equal(flows().length, 1);
  assert.equal(flows()[0]!.targetId, 2);
  assert.equal(composePrompts(100), 1);
  assert.equal(pendings().length, 0);
  await resumePendingAnon(ctxFor(100));
  assert.equal(composePrompts(100), 1, "nothing further");
});

test("Y4. the lease is longer than the webhook function's maxDuration (a lease can not expire while its own worker is alive)", () => {
  const cfg = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const max = cfg.functions["api/webhook.ts"].maxDuration;
  assert.equal(typeof max, "number");
  assert.ok(PENDING_LEASE_MS > max * 1000, `PENDING_LEASE_MS=${PENDING_LEASE_MS} must exceed webhook maxDuration=${max}s`);
});

/* ----------------------------------------------------------- (b) legacy buttons */
const LEGACY_ID = "7000000001:55"; // v1.29.3 format: <senderTelegramId>:<telegram message id>
async function legacyRecord(extra: Record<string, unknown> = {}) {
  mk(7000000001, { anonId: "user_CAAAA1" }); mk(7000000002, { anonId: "user_CAAAA2", age: 30 });
  await col("anon_messages").insertOne({ _id: LEGACY_ID, fromId: 7000000001, toId: 7000000002, text: "پیام قدیمی", kind: "message", createdAt: new Date(), ...extra } as never);
}

test("Y5. isLegacyExposedId: only records without cbId whose id embeds a Telegram id", () => {
  assert.equal(isLegacyExposedId({ _id: "7000000001:55" }), true);
  assert.equal(isLegacyExposedId({ _id: "7000000001:55", cbId: "abc" }), false);
  assert.equal(isLegacyExposedId({ _id: "Ab3_xZ9-kLmQ" }), false, "pre-1.29.3 random ids never contained a Telegram id");
});

test("Y6. old «پاسخ دادن» button: still works, and the keyboard of that message is replaced by one WITHOUT the sender's Telegram id", async () => {
  await legacyRecord();
  await h.callback(7000000002, `anon:reply:${LEGACY_ID}`);
  assert.equal(flows().length, 1, "the reply flow was created exactly as before");
  assert.equal(flows()[0]!.targetId, 7000000001);
  const edits = h.of("editMessageReplyMarkup", 7000000002);
  assert.equal(edits.length, 1);
  const data = keyboardData(edits[0]!);
  assert.equal(data.length, 2, "reply + read (not read yet)");
  for (const d of data) { assert.equal(d.includes("7000000001"), false, "sender id gone: " + d); assert.match(d, /^anon:(reply|read):[A-Za-z0-9_-]{16}$/); }
  const rec = col("anon_messages").byId(LEGACY_ID);
  assert.ok(rec.cbId);
  assert.ok(data.every((d) => d.endsWith(rec.cbId)));
  // the new handle works; the old one (which exposed the id) no longer resolves
  h.resetCalls();
  await h.callback(7000000002, `anon:read:${LEGACY_ID}`);
  assert.equal(col("anon_messages").byId(LEGACY_ID).readAt, undefined, "the old id is dead now");
  assert.ok(answers().includes("این پیام دیگه در دسترس نیست."));
  await h.callback(7000000002, `anon:read:${rec.cbId}`);
  assert.ok(col("anon_messages").byId(LEGACY_ID).readAt, "the new handle works");
  assert.equal(h.of("sendMessage", 7000000001).length, 1, "the sender is told once");
});

test("Y7. old «خوندم» button: marks read, notifies the sender once, and the remaining button carries only the opaque handle", async () => {
  await legacyRecord();
  await h.callback(7000000002, `anon:read:${LEGACY_ID}`);
  assert.ok(col("anon_messages").byId(LEGACY_ID).readAt);
  assert.equal(h.of("sendMessage", 7000000001).length, 1);
  const edits = h.of("editMessageReplyMarkup", 7000000002);
  assert.ok(edits.length >= 1);
  for (const e of edits) for (const d of keyboardData(e)) assert.equal(d.includes("7000000001"), false, "sender id not in any keyboard: " + d);
  assert.ok(keyboardData(edits.at(-1)!).every((d) => d.startsWith("anon:reply:")), "only «پاسخ دادن» remains");
});

test("Y8. if Telegram refuses the keyboard edit the handle is taken back: the old button keeps working (nothing becomes unusable)", async () => {
  await legacyRecord();
  h.failFor("editMessageReplyMarkup", 7000000002, "Bad Request: message is not modified");
  await h.callback(7000000002, `anon:reply:${LEGACY_ID}`);
  assert.equal(flows().length, 1, "the press itself still worked");
  assert.equal(col("anon_messages").byId(LEGACY_ID).cbId, undefined, "no handle was left behind");
  h.clearFailures(); h.resetCalls();
  await h.callback(7000000002, `anon:reply:${LEGACY_ID}`);
  assert.equal(flows().length, 1, "the legacy button still resolves");
  assert.ok(!answers().includes("این پیام دیگه در دسترس نیست."));
});

test("Y9. ownership is still enforced on a legacy id: somebody else pressing it changes nothing and gets the generic answer", async () => {
  await legacyRecord();
  mk(7000000003, { anonId: "user_CAAAA3", age: 30 });
  await h.callback(7000000003, `anon:reply:${LEGACY_ID}`);
  await h.callback(7000000003, `anon:read:${LEGACY_ID}`);
  assert.equal(flows().length, 0);
  assert.equal(col("anon_messages").byId(LEGACY_ID).cbId, undefined, "a stranger's press must not even upgrade the record");
  assert.equal(col("anon_messages").byId(LEGACY_ID).readAt, undefined);
  assert.equal(h.of("editMessageReplyMarkup").length, 0);
  assert.deepEqual([...new Set(answers())], ["این پیام دیگه در دسترس نیست."]);
});

test("Y10. a pre-1.29.3 record (random id, no Telegram id inside) is left exactly as it was: no handle assigned, no keyboard rewrite on «پاسخ دادن»", async () => {
  mk(7000000001, { anonId: "user_CAAAA1" }); mk(7000000002, { anonId: "user_CAAAA2", age: 30 });
  await col("anon_messages").insertOne({ _id: "Ab3xZ9kLmQ_-", fromId: 7000000001, toId: 7000000002, text: "خیلی قدیمی", kind: "message", createdAt: new Date() } as never);
  await h.callback(7000000002, "anon:reply:Ab3xZ9kLmQ_-");
  assert.equal(flows().length, 1);
  assert.equal(col("anon_messages").byId("Ab3xZ9kLmQ_-").cbId, undefined);
  assert.equal(h.of("editMessageReplyMarkup").length, 0);
});

test("Y11. concurrent presses of an old button: one handle only, nothing duplicated", async () => {
  await legacyRecord();
  await Promise.all([h.callback(7000000002, `anon:reply:${LEGACY_ID}`), h.callback(7000000002, `anon:reply:${LEGACY_ID}`)]);
  assert.equal(flows().length, 1);
  const rec = col("anon_messages").byId(LEGACY_ID);
  assert.ok(rec.cbId === undefined || /^[A-Za-z0-9_-]{16}$/.test(rec.cbId));
});
