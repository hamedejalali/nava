/** v1.29.3 — F-02 completion: «خوندم» notice, transactional check+insert, duplicate protection, pending link after the REAL onboarding path.
 *  Mocked Mongo + Telegram (the fake Mongo has no real transaction isolation / write conflicts — see the notes on T2). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const { blockUser } = await import("../../src/db/models/blocks.js");
const { setPendingTarget, peekPendingTarget, createAnonMessage } = await import("../../src/db/models/anonMessages.js");
const { resumePendingAnon, ANON_UNAVAILABLE_TEXT } = await import("../../src/features/anonMessages/index.js");
const { PROVINCES } = await import("../../src/data/provinces.js");
const { citiesForProvince } = await import("../../src/data/cities.js");
const province = PROVINCES.find((p) => p.nameFa === "تهران")!;
const city = citiesForProvince(province.id)[0]!;

const mk = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_B${String(id).padStart(5, "0")}`, nickname: `N${id}`, age: 25, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED", ...extra } as any);
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));
const anonDocs = () => col("anon_messages").all();
const link = (id: number) => `/start msg_user_B${String(id).padStart(5, "0")}`;
const READ_NOTICE = /خوانده شد/;
const noticesTo = (id: number) => texts(id).filter((t) => READ_NOTICE.test(t));
const answers = () => h.of("answerCallbackQuery").map((c) => String(c.payload.text ?? ""));
const composeOpened = (id: number) => texts(id).filter((t) => t.includes("پیامت رو بنویس")).length;

beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); });

/** sender 1 -> recipient 2 delivered through the real bot; returns the stored record */
async function sendOne(from = 1, to = 2) {
  mk(from, { age: 25 }); mk(to, { age: 30 });
  await h.text(from, link(to)); await h.text(from, "سلام");
  assert.equal(anonDocs().length, 1, "precondition: message stored");
  assert.ok(texts(to).some((t) => t.includes("سلام")), "precondition: delivered");
  h.resetCalls();
  return anonDocs()[0]!;
}

/* ------------------------------------------------------------- «خوندم» */
test("R1. normal «خوندم»: readAt stored, the sender is told, the answer says so; a second tap tells nobody again", async () => {
  const m = await sendOne();
  await h.callback(2, `anon:read:${m.cbId}`);
  assert.ok(col("anon_messages").byId(m._id).readAt, "read status stored");
  assert.equal(noticesTo(1).length, 1, "sender got exactly one notice");
  assert.deepEqual(answers(), ["به فرستنده اطلاع داده شد ✅"]);
  h.resetCalls();
  await h.callback(2, `anon:read:${m.cbId}`);
  assert.equal(noticesTo(1).length, 0);
  assert.deepEqual(answers(), ["قبلاً خوانده شده ✅"]);
});

test("R2. «خوندم» after a block (either direction): read status stored, NO notice, and the answer does not claim one", async () => {
  for (const [blocker, blocked] of [[1, 2], [2, 1]] as const) {
    resetState(); h.resetCalls();
    const m = await sendOne();
    await blockUser(blocker, blocked);
    await h.callback(2, `anon:read:${m.cbId}`);
    assert.ok(col("anon_messages").byId(m._id).readAt, `local status updated (blocker ${blocker})`);
    assert.equal(h.of("sendMessage", 1).length, 0, `nothing at all was sent to the sender (blocker ${blocker})`);
    assert.deepEqual(answers(), ["خوانده شد ✅"]);
    assert.ok(!answers().join().match(/اطلاع داده شد|بلاک|سن/), "no false claim, no hint");
  }
});

test("R3. «خوندم» after an age-band change: silent read, no notice, honest answer", async () => {
  const m = await sendOne();
  await col("users").updateOne({ _id: 1 }, { $set: { age: 15 } });
  await h.callback(2, `anon:read:${m.cbId}`);
  assert.ok(col("anon_messages").byId(m._id).readAt);
  assert.equal(h.of("sendMessage", 1).length, 0);
  assert.deepEqual(answers(), ["خوانده شد ✅"]);
  // and the other way round: the recipient's age changes
  resetState(); h.resetCalls();
  const m2 = await sendOne();
  await col("users").updateOne({ _id: 2 }, { $set: { age: null } });
  await h.callback(2, `anon:read:${m2.cbId}`);
  assert.equal(h.of("sendMessage", 1).length, 0);
});

test("R4. when the notice can not be delivered the answer does not say it was", async () => {
  const m = await sendOne();
  h.failFor("sendMessage", 1);
  await h.callback(2, `anon:read:${m.cbId}`);
  assert.ok(col("anon_messages").byId(m._id).readAt);
  assert.deepEqual(answers(), ["خوانده شد ✅"]);
});

test("R5. stale / foreign callbacks: someone else's tap, an unknown id and a banned sender notify nobody", async () => {
  const m = await sendOne();
  mk(3, { age: 30 });
  await h.callback(3, `anon:read:${m.cbId}`); // forwarded button pressed by a third person
  assert.equal(col("anon_messages").byId(m._id).readAt, undefined, "only the recipient can mark it read");
  assert.equal(h.of("sendMessage", 1).length, 0);
  await h.callback(2, `anon:read:does-not-exist`);
  assert.equal(h.of("sendMessage", 1).length, 0);
  await col("users").updateOne({ _id: 1 }, { $set: { banned: true } });
  await h.callback(2, `anon:read:${m.cbId}`);
  assert.ok(col("anon_messages").byId(m._id).readAt);
  assert.equal(h.of("sendMessage", 1).length, 0, "a banned sender is not messaged");
});

test("R6. stale «پاسخ دادن» button: refused after a block / age change / deleted message; no flow, no record", async () => {
  const m = await sendOne();
  await blockUser(1, 2);
  await h.callback(2, `anon:reply:${m.cbId}`);
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.ok(h.of("answerCallbackQuery").some((c) => String(c.payload.text) === ANON_UNAVAILABLE_TEXT));
  resetState(); h.resetCalls();
  const m2 = await sendOne();
  await col("users").updateOne({ _id: 2 }, { $set: { age: 12 } });
  await h.callback(2, `anon:reply:${m2.cbId}`);
  assert.equal(col("anon_msg_flow").all().length, 0);
  h.resetCalls();
  await h.callback(2, `anon:reply:never-existed`);
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.equal(anonDocs().length, 1, "no reply record was created anywhere");
});

test("R7. a reply flow opened BEFORE a block is refused at the moment the text arrives: nothing stored, nothing delivered", async () => {
  const m = await sendOne();
  await h.callback(2, `anon:reply:${m.cbId}`);
  assert.equal(col("anon_msg_flow").all().length, 1);
  await blockUser(1, 2);
  h.resetCalls();
  await h.text(2, "جواب");
  assert.equal(anonDocs().length, 1, "no second record");
  assert.equal(h.of("sendMessage", 1).filter((c) => String(c.payload.text).includes("جواب")).length, 0);
  assert.ok(texts(2).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(col("anon_msg_flow").all().length, 0);
});

/* ------------------------------------------------- check + insert race */
test("T1. the authorization changes AFTER the handler's early check but BEFORE the final check: refused, no record, no delivery", async () => {
  const m = await sendOne();
  await h.callback(2, `anon:reply:${m.cbId}`); // reply flow
  // the reply handler looks the original message up between the early check and delivery(): a block lands exactly there
  const { getClient } = await import("../../src/db/connect.js");
  const stats = (await getClient() as any).stats;
  const abortedBefore = stats.transactionsAborted;
  const c: any = col("anon_messages");
  const orig = c.findOne.bind(c);
  let injected = 0;
  c.findOne = async (...a: any[]) => { if (!injected++) await blockUser(1, 2); return orig(...a); };
  try {
    h.resetCalls();
    await h.text(2, "جواب");
  } finally { c.findOne = orig; }
  assert.equal(injected >= 1, true, "the injection point really ran");
  assert.equal(stats.transactionsAborted - abortedBefore, 1, "the refusal happened INSIDE the transaction (aborted, not committed)");
  assert.equal(anonDocs().length, 1, "no reply record");
  assert.equal(h.of("sendMessage", 1).filter((x) => String(x.payload.text).includes("جواب")).length, 0, "nothing delivered");
  assert.ok(texts(2).includes(ANON_UNAVAILABLE_TEXT));
});

test("T2. the final check and the insert run in ONE transaction (mock: proves the structure, NOT real isolation)", async () => {
  mk(1, { age: 25 }); mk(2, { age: 30 }); mk(3, { age: 15 });
  const { getClient } = await import("../../src/db/connect.js");
  const stats = (await getClient() as any).stats;
  // baseline: a message that is refused BEFORE any transaction of this feature (other middleware may use transactions itself)
  await h.text(3, link(2)); // cross-band: no flow
  const b0 = { s: stats.transactionsStarted, c: stats.transactionsCommitted };
  await h.text(3, "x");
  const base = { s: stats.transactionsStarted - b0.s, c: stats.transactionsCommitted - b0.c };
  await h.text(1, link(2));
  const d0 = { s: stats.transactionsStarted, c: stats.transactionsCommitted };
  await h.text(1, "سلام");
  assert.equal(stats.transactionsStarted - d0.s - base.s, 1, "exactly one extra transaction for the delivery");
  assert.equal(stats.transactionsCommitted - d0.c - base.c, 1, "and it committed");
  assert.equal(anonDocs().length, 1);
});

test("C1. the same Telegram message processed twice at once creates ONE record and ONE delivery", async () => {
  mk(1, { age: 25 }); mk(2, { age: 30 });
  await h.text(1, link(2));
  h.resetCalls();
  await Promise.all([h.text(1, "یک پیام", 4242), h.text(1, "یک پیام", 4242)]);
  assert.equal(anonDocs().length, 1, "one record");
  assert.equal(anonDocs()[0]!._id, "1:4242", "record id is derived from the Telegram message");
  assert.equal(h.of("sendMessage", 2).filter((c) => String(c.payload.text).includes("یک پیام")).length, 1, "one delivery");
  // a redelivery AFTER completion (retry) is harmless too
  await h.text(1, "یک پیام", 4242);
  assert.equal(anonDocs().length, 1);
  assert.equal(h.of("sendMessage", 2).filter((c) => String(c.payload.text).includes("یک پیام")).length, 1);
});

test("C2. two DIFFERENT messages are two records, each delivered once (not collapsed)", async () => {
  mk(1, { age: 25 }); mk(2, { age: 30 });
  await h.text(1, link(2));
  await h.text(1, "اول", 7001);
  await h.text(1, link(2));
  await h.text(1, "دوم", 7002);
  assert.deepEqual(anonDocs().map((d: any) => d.text).sort(), ["اول", "دوم"]);
  assert.equal(h.of("sendMessage", 2).filter((c) => /اول|دوم/.test(String(c.payload.text))).length, 2);
});

test("C3. a record id that already exists is reported as duplicate: the stored text is not overwritten", async () => {
  mk(1); mk(2);
  const first = await createAnonMessage({ fromId: 1, toId: 2, text: "orig", kind: "message" }, { id: "1:99" });
  await assert.rejects(() => createAnonMessage({ fromId: 1, toId: 2, text: "other", kind: "message" }, { id: "1:99" }), (e: any) => e.code === 11000);
  assert.equal(col("anon_messages").byId(first._id).text, "orig");
});

test("C4. delivery failure (recipient blocked the bot) leaves no record, and the sender is told the honest generic failure", async () => {
  mk(1, { age: 25 }); mk(2, { age: 30 });
  await h.text(1, link(2));
  h.failFor("sendMessage", 2);
  await h.text(1, "سلام");
  assert.equal(anonDocs().length, 0);
  assert.ok(texts(1).some((t) => t.includes("تحویل داده نشد")));
});

/* ------------------------------------- pending link + REAL onboarding */
async function onboardThroughRealBot(id: number, age: string, firstMessage: string) {
  await h.text(id, firstMessage);          // /start msg_<anonId> (the link) — or plain /start
  await h.callback(id, "lang:fa");
  await h.callback(id, "gender:male");
  await h.text(id, age);
  await h.text(id, province.nameFa);
  await h.text(id, city.nameFa);
  await h.text(id, "Ali");                 // setNicknameOnce() -> completion -> resumePendingAnon(ctx)
}

test("O1. REAL onboarding path: a new user who came through a link finishes onboarding and the compose step opens exactly once", async () => {
  mk(2, { age: 25 });
  const NEW = 6001;
  await onboardThroughRealBot(NEW, "25", link(2));
  assert.equal(col("users").byId(NEW).onboardingStep, "COMPLETED");
  assert.equal(composeOpened(NEW), 1, "exactly one compose prompt");
  assert.equal(col("anon_msg_flow").all().length, 1);
  assert.equal(col("anon_msg_flow").byId(NEW).targetId, 2);
  assert.equal(await peekPendingTarget(NEW), null, "pending link consumed");
  h.resetCalls();
  await h.text(NEW, "سلام از کاربر جدید");
  assert.equal(anonDocs().length, 1);
  assert.equal(anonDocs()[0]!.fromId, NEW);
  assert.ok(texts(2).some((t) => t.includes("سلام از کاربر جدید")));
  assert.equal(h.of("sendMessage", 2).filter((c) => String(c.payload.text).includes("سلام از کاربر جدید")).length, 1, "delivered once");
});

test("O2. REAL onboarding path: the age typed during onboarding is on the other side of 18 — refused, link dropped, nothing stored or sent", async () => {
  mk(2, { age: 15 });
  const NEW = 6002;
  await onboardThroughRealBot(NEW, "25", link(2));
  assert.equal(col("users").byId(NEW).onboardingStep, "COMPLETED");
  assert.ok(texts(NEW).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(composeOpened(NEW), 0);
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.equal(await peekPendingTarget(NEW), null);
  assert.equal(ANON_UNAVAILABLE_TEXT.match(/سن|۱۸|18|بلاک/), null, "the refusal text itself does not mention age or blocks");
  await h.text(NEW, "سلام");
  assert.equal(anonDocs().length, 0);
  assert.equal(texts(2).length, 0);
});

test("O3. REAL onboarding path: the target blocks the person while they are still onboarding — refused at completion", async () => {
  mk(2, { age: 25 });
  const NEW = 6003;
  await h.text(NEW, link(2));
  await blockUser(2, NEW);
  await h.callback(NEW, "lang:fa"); await h.callback(NEW, "gender:male");
  await h.text(NEW, "25"); await h.text(NEW, province.nameFa); await h.text(NEW, city.nameFa); await h.text(NEW, "Ali");
  assert.ok(texts(NEW).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.equal(anonDocs().length, 0);
});

test("O4. resume is claimed atomically: onboarding completion and a force-join «joined» resume together open ONE compose step", async () => {
  mk(2, { age: 25 }); mk(3, { age: 25 });
  await setPendingTarget(3, 2);
  const mkCtx = () => ({ from: { id: 3 }, chat: { id: 3 }, api: h.bot.api, dbUser: { ...col("users").byId(3), onboardingStep: "NICKNAME_PENDING" }, userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(3, t, o) }) as any;
  h.resetCalls();
  await Promise.all([resumePendingAnon(mkCtx()), resumePendingAnon(mkCtx())]);
  assert.equal(composeOpened(3), 1, "stale ctx.dbUser (still NICKNAME_PENDING) does not block it, and it is not opened twice");
  assert.equal(await peekPendingTarget(3), null);
});

test("O5. a user whose stored onboarding is NOT complete is not resumed (the link stays pending)", async () => {
  mk(2, { age: 25 }); mk(4, { age: 25, onboardingStep: "NICKNAME_PENDING" });
  await setPendingTarget(4, 2);
  await resumePendingAnon({ from: { id: 4 }, chat: { id: 4 }, api: h.bot.api, dbUser: { onboardingStep: "COMPLETED" }, userLang: "fa", reply: (t: string) => h.bot.api.sendMessage(4, t) } as any);
  assert.equal(composeOpened(4), 0, "a lying stale ctx.dbUser can not make an unfinished user write");
  assert.equal(await peekPendingTarget(4), 2);
});
