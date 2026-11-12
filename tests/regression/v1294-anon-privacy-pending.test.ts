/** v1.29.4 — F-22 opaque callback ids, F-23 pending link after Mini App signup, F-24 recoverable (leased) pending link, F-25 sender ban.
 *  Mocked Mongo + Telegram: proves application logic and ordering, NOT real MongoDB concurrency / isolation. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const { blockUser } = await import("../../src/db/models/blocks.js");
const am = await import("../../src/db/models/anonMessages.js");
const { setPendingTarget, peekPendingTarget, claimPendingTarget, completePending, releasePending, PENDING_LEASE_MS, PENDING_MAX_ATTEMPTS } = am;
const { resumePendingAnon, mayWriteNow, ANON_UNAVAILABLE_TEXT } = await import("../../src/features/anonMessages/index.js");
const { onboardSave } = await import("../../src/services/miniOnboarding.js");
const { addChannel } = await import("../../src/db/models/channel.js");
const { PROVINCES } = await import("../../src/data/provinces.js");
const { citiesForProvince } = await import("../../src/data/cities.js");
const province = PROVINCES[0]!;
const city = citiesForProvince(province.id)[0]!;

const BIG_FROM = 7000000001;
const BIG_TO = 7000000002;
const mk = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_B${String(id % 100000).padStart(5, "0")}`, nickname: `N${id}`, age: 25, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED", ...extra } as any);
const linkTo = (id: number) => `/start msg_${col("users").byId(id).anonId}`;
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));
const anonDocs = () => col("anon_messages").all();
const flows = () => col("anon_msg_flow").all();
const pendings = () => col("anon_pending_target").all();
const composePrompts = (id: number) => texts(id).filter((t) => t.includes("پیامت رو بنویس")).length;
const answers = () => h.of("answerCallbackQuery").map((c) => String(c.payload.text ?? ""));
const buttonsOf = (id: number) => h.of("sendMessage", id).flatMap((c) => (c.payload.reply_markup?.inline_keyboard ?? []).flat()).map((b: any) => String(b.callback_data ?? ""));

// join-screen control: one permanent interceptor, switched per test
const notJoined = new Set<number>();
(h.bot.api.config as any).use(async (prev: any, method: string, payload: any) => {
  if (method === "getChatMember" && notJoined.has(payload.user_id)) return { ok: true, result: { status: "left", user: { id: payload.user_id, is_bot: false, first_name: "x" } } };
  return prev(method, payload);
});

beforeEach(() => { resetState(); h.resetCalls(); h.clearFailures(); notJoined.clear(); });

/** sender -> recipient through the real bot; returns the stored record */
async function sendOne(from: number, to: number, body = "سلام") {
  await h.text(from, linkTo(to)); await h.text(from, body);
  assert.equal(anonDocs().length >= 1, true, "precondition: stored");
  return anonDocs().at(-1)!;
}

/* ============================================================== F-22 */
test("X1. the buttons on a delivered anonymous message carry an opaque handle: no Telegram id anywhere in callback_data", async () => {
  mk(BIG_FROM, { anonId: "user_AAAAA1" }); mk(BIG_TO, { anonId: "user_AAAAA2", age: 30 });
  const m = await sendOne(BIG_FROM, BIG_TO, "پیام محرمانه");
  assert.equal(m._id.startsWith(`${BIG_FROM}:`), true, "internal record key is unchanged (deterministic, used only for duplicate protection)");
  assert.ok(m.cbId && m.cbId !== m._id, "the record has a separate opaque handle");
  const data = buttonsOf(BIG_TO).filter((d) => d.startsWith("anon:"));
  assert.equal(data.length, 2, "reply + read buttons");
  for (const d of data) {
    assert.match(d, /^anon:(reply|read):[A-Za-z0-9_-]{16}$/);
    assert.equal(d.includes(String(BIG_FROM)), false, "sender id not in callback data");
    assert.equal(d.includes(String(BIG_TO)), false, "recipient id not in callback data");
    assert.equal(d.includes(m._id), false);
    assert.ok(d.endsWith(m.cbId!));
  }
  // nothing else the recipient can see carries the sender id either
  const allPayloads = JSON.stringify(h.of("sendMessage", BIG_TO).map((c) => c.payload));
  assert.equal(allPayloads.includes(String(BIG_FROM)), false);
});

test("X2. handles are random per message; the duplicate-protection key still collapses a repeated Telegram message", async () => {
  mk(BIG_FROM, { anonId: "user_AAAAA1" }); mk(BIG_TO, { anonId: "user_AAAAA2", age: 30 });
  await h.text(BIG_FROM, linkTo(BIG_TO));
  await Promise.all([h.text(BIG_FROM, "یک", 9001), h.text(BIG_FROM, "یک", 9001)]);
  assert.equal(anonDocs().length, 1, "duplicate protection works independently of the public handle");
  await h.text(BIG_FROM, linkTo(BIG_TO)); await h.text(BIG_FROM, "دو", 9002);
  const [a, b] = anonDocs();
  assert.equal(anonDocs().length, 2);
  assert.notEqual(a!.cbId, b!.cbId);
  assert.equal(a!._id, `${BIG_FROM}:9001`);
});

test("X3. the recipient can not reach a NEW record through its internal key (no 'is the sender X?' oracle)", async () => {
  mk(1, { anonId: "user_AAAAA1" }); mk(2, { anonId: "user_AAAAA2", age: 30 });
  const m = await sendOne(1, 2);
  h.resetCalls();
  await h.callback(2, `anon:read:${m._id}`);
  assert.equal(col("anon_messages").byId(m._id).readAt, undefined, "nothing happened");
  assert.equal(h.of("sendMessage", 1).length, 0);
  await h.callback(2, `anon:reply:${m._id}`);
  assert.equal(flows().length, 0);
  assert.ok(answers().every((t) => t === "این پیام دیگه در دسترس نیست." || t === ANON_UNAVAILABLE_TEXT), "same answer as for any unknown id");
});

test("X4. forged / foreign / malformed handles are rejected for both buttons, with identical answers, and change nothing", async () => {
  mk(1, { anonId: "user_AAAAA1" }); mk(2, { anonId: "user_AAAAA2", age: 30 }); mk(3, { anonId: "user_AAAAA3", age: 30 });
  const m = await sendOne(1, 2);
  h.resetCalls();
  const bad = [m.cbId!.slice(0, -1) + (m.cbId!.endsWith("A") ? "B" : "A"), "x".repeat(200), "$ne", "../../etc", "a:b:c:d", "", "%00"];
  for (const id of bad) { await h.callback(2, `anon:read:${id}`); await h.callback(2, `anon:reply:${id}`); }
  // somebody else holding the REAL handle (forwarded button, shoulder-surfing, manipulated callback)
  await h.callback(3, `anon:read:${m.cbId}`);
  await h.callback(3, `anon:reply:${m.cbId}`);
  assert.equal(col("anon_messages").byId(m._id).readAt, undefined, "not marked read");
  assert.equal(flows().length, 0, "no reply flow for anybody");
  assert.equal(h.of("sendMessage", 1).length, 0, "the sender is never notified");
  assert.equal(anonDocs().length, 1);
  assert.equal(new Set(answers()).size <= 2, true, "no distinguishing answers: " + [...new Set(answers())].join(" | "));
});

test("X5. the real recipient still can reply and mark read through the handle; the reply travels back with opaque buttons too", async () => {
  mk(BIG_FROM, { anonId: "user_AAAAA1" }); mk(BIG_TO, { anonId: "user_AAAAA2", age: 30 });
  const m = await sendOne(BIG_FROM, BIG_TO);
  h.resetCalls();
  await h.callback(BIG_TO, `anon:reply:${m.cbId}`);
  assert.equal(flows()[0]!.targetId, BIG_FROM);
  assert.equal(flows()[0]!.replyToId, m._id, "the flow keeps the internal key (never shown to anybody)");
  await h.text(BIG_TO, "جواب");
  assert.equal(anonDocs().length, 2);
  assert.ok(texts(BIG_FROM).some((t) => t.includes("جواب")));
  for (const d of buttonsOf(BIG_FROM).filter((x) => x.startsWith("anon:"))) {
    assert.equal(d.includes(String(BIG_TO)) || d.includes(String(BIG_FROM)), false);
  }
  h.resetCalls();
  await h.callback(BIG_TO, `anon:read:${m.cbId}`);
  assert.ok(col("anon_messages").byId(m._id).readAt);
  assert.equal(h.of("sendMessage", BIG_FROM).length, 1, "read notice delivered");
});

test("X6. COMPATIBILITY: buttons of records written before v1.29.4 (no handle) keep working for their recipient only", async () => {
  mk(1); mk(2, { age: 30 }); mk(3, { age: 30 });
  // a v1.29.2-style record (random _id) and a v1.29.3-style record (_id '<from>:<msg>'), neither has a cbId
  await col("anon_messages").insertOne({ _id: "AbCdEfGhIjKl", fromId: 1, toId: 2, text: "قدیمی", kind: "message", createdAt: new Date() } as any);
  await col("anon_messages").insertOne({ _id: "1:555", fromId: 1, toId: 2, text: "نسخه ۱.۲۹.۳", kind: "message", createdAt: new Date() } as any);
  h.resetCalls();
  await h.callback(3, "anon:read:AbCdEfGhIjKl");
  await h.callback(3, "anon:read:1:555");
  assert.equal(col("anon_messages").byId("AbCdEfGhIjKl").readAt, undefined, "a stranger is rejected");
  assert.equal(col("anon_messages").byId("1:555").readAt, undefined);
  await h.callback(2, "anon:read:AbCdEfGhIjKl");
  await h.callback(2, "anon:read:1:555");
  assert.ok(col("anon_messages").byId("AbCdEfGhIjKl").readAt, "owner still works (old button)");
  assert.ok(col("anon_messages").byId("1:555").readAt);
  await h.callback(2, "anon:reply:AbCdEfGhIjKl");
  assert.equal(flows()[0]!.targetId, 1);
});

/* ============================================================== F-25 */
test("B1. mayWriteNow reads BOTH accounts fresh: a banned sender or a banned recipient is refused", async () => {
  mk(1); mk(2, { age: 30 });
  assert.equal(await mayWriteNow(1, 2), true);
  await col("users").updateOne({ _id: 1 }, { $set: { banned: true } });
  assert.equal(await mayWriteNow(1, 2), false, "sender banned");
  await col("users").updateOne({ _id: 1 }, { $set: { banned: false } });
  assert.equal(await mayWriteNow(1, 2), true);
  await col("users").updateOne({ _id: 2 }, { $set: { banned: true } });
  assert.equal(await mayWriteNow(1, 2), false, "recipient banned");
  await col("users").updateOne({ _id: 2 }, { $set: { banned: false } });
  await blockUser(2, 1);
  assert.equal(await mayWriteNow(1, 2), false, "block still enforced");
});

async function replyScenario(inject: () => Promise<void>) {
  mk(1); mk(2, { age: 30 });
  const m = await sendOne(1, 2);
  await h.callback(2, `anon:reply:${m.cbId}`);
  const c: any = col("anon_messages");
  const orig = c.findOne.bind(c);
  let fired = 0;
  c.findOne = async (...a: any[]) => { if (!fired++) await inject(); return orig(...a); };
  h.resetCalls();
  try { await h.text(2, "جواب"); } finally { c.findOne = orig; }
  assert.ok(fired >= 1, "the injection ran between the handler's early check and delivery");
  return m;
}

test("B2. the SENDER is banned after the middleware loaded ctx.dbUser and the early check passed: nothing stored, nothing delivered", async () => {
  await replyScenario(async () => { await col("users").updateOne({ _id: 2 }, { $set: { banned: true } }); });
  assert.equal(anonDocs().length, 1, "no reply record");
  assert.equal(h.of("sendMessage", 1).filter((c) => String(c.payload.text).includes("جواب")).length, 0);
});

test("B3. the RECIPIENT is banned before the final authorization: nothing stored, nothing delivered", async () => {
  await replyScenario(async () => { await col("users").updateOne({ _id: 1 }, { $set: { banned: true } }); });
  assert.equal(anonDocs().length, 1);
  assert.equal(h.of("sendMessage", 1).filter((c) => String(c.payload.text).includes("جواب")).length, 0);
});

test("B4. a banned person can not trigger a read notice either", async () => {
  mk(1); mk(2, { age: 30 });
  const m = await sendOne(1, 2);
  await col("users").updateOne({ _id: 2 }, { $set: { banned: true } });
  h.resetCalls();
  assert.equal(await mayWriteNow(2, 1), false);
  void m;
});

/* ============================================================== F-24 */
const NEW = 6100;
const claimOf = async (id: number) => claimPendingTarget(id);

test("L1. concurrent claims: exactly one worker gets the link", async () => {
  mk(2); mk(NEW, { onboardingStep: "COMPLETED" });
  await setPendingTarget(NEW, 2);
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => claimOf(NEW)));
  assert.equal(got.filter(Boolean).length, 1);
  assert.equal((await peekPendingTarget(NEW)), 2, "the record is still there (leased, not deleted)");
  assert.equal(pendings()[0]!.attempts, 1);
});

test("L2. worker failure: the lease keeps others out, then expires and a retry completes ONCE (one flow, one prompt)", async () => {
  mk(2, { age: 25 }); mk(NEW, { age: 25 });
  await setPendingTarget(NEW, 2);
  const flowsCol: any = col("anon_msg_flow");
  const origReplace = flowsCol.replaceOne.bind(flowsCol);
  let boom = 1;
  flowsCol.replaceOne = async (...a: any[]) => { if (boom-- > 0) throw new Error("temporary database failure"); return origReplace(...a); };
  const ctx = () => ({ from: { id: NEW }, chat: { id: NEW }, api: h.bot.api, dbUser: { onboardingStep: "NICKNAME_PENDING" }, userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(NEW, t, o) }) as any;
  await assert.rejects(() => resumePendingAnon(ctx()), /temporary database failure/);
  assert.equal(await peekPendingTarget(NEW), 2, "the link survived the failure");
  assert.equal(flows().length, 0);
  assert.equal(composePrompts(NEW), 0);
  await resumePendingAnon(ctx()); // lease still running → nobody else may continue it
  assert.equal(flows().length, 0, "lease respected");
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { claimUntil: Date.now() - 1 } }); // the lease runs out
  await resumePendingAnon(ctx());
  assert.equal(flows().length, 1);
  assert.equal(flows()[0]!.targetId, 2);
  assert.equal(composePrompts(NEW), 1);
  assert.equal(pendings().length, 0, "completed only now");
  await resumePendingAnon(ctx()); await resumePendingAnon(ctx());
  assert.equal(composePrompts(NEW), 1, "nothing further");
});

test("L3. (v1.29.6: link removal + flow creation are ONE transaction) a crash at that step leaves neither; the retry creates exactly one flow and one prompt", async () => {
  mk(2); mk(NEW);
  await setPendingTarget(NEW, 2);
  const pcol: any = col("anon_pending_target");
  const origDelete = pcol.deleteOne.bind(pcol);
  let boom = 1;
  pcol.deleteOne = async (...a: any[]) => { if (boom-- > 0) throw new Error("connection lost"); return origDelete(...a); };
  const ctx = () => ({ from: { id: NEW }, chat: { id: NEW }, api: h.bot.api, dbUser: {}, userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(NEW, t, o) }) as any;
  await assert.rejects(() => resumePendingAnon(ctx()), /connection lost/);
  assert.equal(flows().length, 0, "v1.29.6: the step is atomic — the crash left no half-done state (v1.29.4 wrote the flow first and could leave it behind)");
  assert.equal(pendings().length, 1, "the link is still there for the retry");
  assert.equal(composePrompts(NEW), 0, "the prompt is only sent after completion");
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { claimUntil: 1 } });
  await resumePendingAnon(ctx());
  assert.equal(flows().length, 1, "still ONE flow");
  assert.equal(composePrompts(NEW), 1, "exactly one prompt over the whole history");
  assert.equal(pendings().length, 0);
  await h.text(NEW, "پیام");
  assert.equal(anonDocs().length, 1, "and the message is created once");
});

test("L4. bounded retries: after PENDING_MAX_ATTEMPTS failed claims the link is not offered again", async () => {
  mk(2); mk(NEW);
  await setPendingTarget(NEW, 2);
  for (let i = 0; i < PENDING_MAX_ATTEMPTS; i++) {
    assert.ok(await claimOf(NEW), `claim ${i + 1}`);
    await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { claimUntil: 1 } }); // each worker "died"
  }
  assert.equal(await claimOf(NEW), null);
  // a link the user opens again starts fresh
  await setPendingTarget(NEW, 2);
  assert.ok(await claimOf(NEW));
});

test("L5. expired link: not claimable, removed, no flow", async () => {
  mk(2); mk(NEW);
  await setPendingTarget(NEW, 2);
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { createdAt: Date.now() - 25 * 3600 * 1000 } });
  assert.equal(await claimOf(NEW), null);
  assert.equal(pendings().length, 0, "housekeeping removed it");
  await setPendingTarget(NEW, 2);
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { createdAt: Date.now() - 25 * 3600 * 1000 } });
  await resumePendingAnon({ from: { id: NEW }, chat: { id: NEW }, api: h.bot.api, dbUser: {}, userLang: "fa", reply: (t: string) => h.bot.api.sendMessage(NEW, t) } as any);
  assert.equal(flows().length, 0);
  assert.equal(composePrompts(NEW), 0);
});

test("L6. only the lease holder can complete / release; a stale worker can not delete a link somebody else now holds", async () => {
  mk(2); mk(NEW);
  await setPendingTarget(NEW, 2);
  const a = (await claimOf(NEW))!;
  assert.equal(await completePending(NEW, "wrong-token"), false);
  assert.equal(pendings().length, 1);
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { claimUntil: 1 } });
  const b = (await claimOf(NEW))!;
  assert.notEqual(a.token, b.token);
  assert.equal(await completePending(NEW, a.token), false, "the first (dead) worker lost its lease");
  assert.equal(pendings().length, 1);
  await releasePending(NEW, b.token);
  assert.equal(pendings()[0]!.claimToken, undefined);
  assert.equal(pendings()[0]!.attempts, 0);
  assert.ok(PENDING_LEASE_MS >= 30_000);
});

test("L7. force-join screen: the link is handed back (not lost, not counted as a failure) and continues after «عضو شدم»", async () => {
  mk(2); mk(NEW);
  await addChannel({ title: "کانال", chatRef: "@navatestx", url: "https://t.me/navatestx", handle: "@navatestx" });
  notJoined.add(NEW);
  await setPendingTarget(NEW, 2);
  const ctx = () => ({ from: { id: NEW }, chat: { id: NEW }, api: h.bot.api, dbUser: {}, userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(NEW, t, o) }) as any;
  await resumePendingAnon(ctx());
  assert.equal(flows().length, 0);
  assert.equal(pendings().length, 1, "still pending");
  assert.equal(pendings()[0]!.claimToken, undefined, "released");
  assert.equal(pendings()[0]!.attempts, 0);
  assert.ok(texts(NEW).length >= 1, "join screen shown");
  notJoined.delete(NEW);
  h.resetCalls();
  await h.callback(NEW, "forcejoin:verify");
  assert.equal(flows().length, 1);
  assert.equal(composePrompts(NEW), 1);
  assert.equal(pendings().length, 0);
});

test("L8. a refusal (block) completes the link for good; nothing is created or sent", async () => {
  mk(2); mk(NEW);
  await blockUser(2, NEW);
  await setPendingTarget(NEW, 2);
  await resumePendingAnon({ from: { id: NEW }, chat: { id: NEW }, api: h.bot.api, dbUser: {}, userLang: "fa", reply: (t: string) => h.bot.api.sendMessage(NEW, t) } as any);
  assert.equal(pendings().length, 0);
  assert.equal(flows().length, 0);
  assert.ok(texts(NEW).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(texts(2).length, 0);
});

test("L9. recovery point: a finished user whose continuation was interrupted gets it back on the next plain /start", async () => {
  mk(2); mk(NEW);
  await setPendingTarget(NEW, 2);
  assert.ok(await claimOf(NEW)); // a worker took it and died
  await h.text(NEW, "/start"); // lease still running → nothing
  assert.equal(flows().length, 0);
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { claimUntil: 1 } });
  h.resetCalls();
  await h.text(NEW, "/start");
  assert.equal(flows().length, 1);
  assert.equal(composePrompts(NEW), 1);
  assert.equal(pendings().length, 0);
});

/* ============================================================== F-23 */
const tgUser = (id: number) => ({ id, first_name: "N" }) as any;
const goodInput = { gender: "male", age: 25, province: province.id, city: city.id, nickname: "Ali" };

async function openLinkAsNewUser(id: number, targetId: number) {
  await h.text(id, linkTo(targetId)); // new user: the bot stores the link and starts onboarding
  assert.equal(await peekPendingTarget(id), targetId, "precondition: pending link stored");
}

test("M1. successful Mini App onboarding continues the pending link exactly once, then the message is delivered", async () => {
  mk(2, { age: 25 });
  await openLinkAsNewUser(NEW, 2);
  h.resetCalls();
  const r = await onboardSave(tgUser(NEW), goodInput, h.bot.api as any);
  assert.equal(r.status, "completed");
  assert.equal(col("users").byId(NEW).onboardingStep, "COMPLETED");
  assert.equal(flows().length, 1);
  assert.equal(flows()[0]!.targetId, 2);
  assert.equal(composePrompts(NEW), 1);
  assert.equal(pendings().length, 0);
  await h.text(NEW, "از مینی‌اپ");
  assert.equal(anonDocs().length, 1);
  assert.equal(anonDocs()[0]!.fromId, NEW);
  assert.equal(h.of("sendMessage", 2).filter((c) => String(c.payload.text).includes("از مینی‌اپ")).length, 1);
});

test("M2. duplicate / concurrent completion events create ONE flow and ONE prompt", async () => {
  mk(2, { age: 25 });
  await openLinkAsNewUser(NEW, 2);
  h.resetCalls();
  const rs = await Promise.all([onboardSave(tgUser(NEW), goodInput, h.bot.api as any), onboardSave(tgUser(NEW), goodInput, h.bot.api as any)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ["already", "completed"]);
  await onboardSave(tgUser(NEW), goodInput, h.bot.api as any);
  assert.equal(flows().length, 1);
  assert.equal(composePrompts(NEW), 1);
  assert.equal(anonDocs().length, 0, "no message was created by the continuation itself");
});

test("M3. a block placed before completion: neutral refusal, no flow, link finished", async () => {
  mk(2, { age: 25 });
  await openLinkAsNewUser(NEW, 2);
  await blockUser(2, NEW);
  h.resetCalls();
  await onboardSave(tgUser(NEW), goodInput, h.bot.api as any);
  assert.ok(texts(NEW).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(flows().length, 0);
  assert.equal(composePrompts(NEW), 0);
  assert.equal(pendings().length, 0);
});

test("M4. age band: an age typed in the Mini App that does not match the target is refused; no flow, nothing sent to the target", async () => {
  mk(2, { age: 15 });
  await openLinkAsNewUser(NEW, 2);
  h.resetCalls();
  await onboardSave(tgUser(NEW), goodInput, h.bot.api as any); // 25 vs 15
  assert.ok(texts(NEW).includes(ANON_UNAVAILABLE_TEXT));
  assert.equal(flows().length, 0);
  assert.equal(texts(2).length, 0);
});

test("M5. an expired pending link is not continued", async () => {
  mk(2, { age: 25 });
  await openLinkAsNewUser(NEW, 2);
  await col("anon_pending_target").updateOne({ _id: NEW }, { $set: { createdAt: Date.now() - 25 * 3600 * 1000 } });
  h.resetCalls();
  await onboardSave(tgUser(NEW), goodInput, h.bot.api as any);
  assert.equal(flows().length, 0);
  assert.equal(composePrompts(NEW), 0);
  assert.equal(texts(NEW).includes(ANON_UNAVAILABLE_TEXT), false);
});

test("M6. invalid onboarding input does not continue anything and keeps the link pending; no link = no extra messages", async () => {
  mk(2, { age: 25 });
  await openLinkAsNewUser(NEW, 2);
  const r = await onboardSave(tgUser(NEW), { ...goodInput, age: 3 }, h.bot.api as any);
  assert.equal(r.status, "invalid");
  assert.equal(flows().length, 0);
  assert.equal(await peekPendingTarget(NEW), 2);
  const OTHER = 6200;
  h.resetCalls();
  await onboardSave(tgUser(OTHER), goodInput, h.bot.api as any);
  assert.equal(composePrompts(OTHER), 0);
  assert.equal(flows().length, 0);
});

test("M7. required channel not joined: the join screen appears (once), the link stays pending and continues after verification", async () => {
  mk(2, { age: 25 });
  await addChannel({ title: "کانال", chatRef: "@navatesty", url: "https://t.me/navatesty", handle: "@navatesty" });
  notJoined.add(NEW);
  await openLinkAsNewUser(NEW, 2);
  h.resetCalls();
  await onboardSave(tgUser(NEW), goodInput, h.bot.api as any);
  assert.equal(flows().length, 0);
  assert.equal(pendings().length, 1);
  assert.equal(composePrompts(NEW), 0);
  notJoined.delete(NEW);
  await h.callback(NEW, "forcejoin:verify");
  assert.equal(flows().length, 1);
  assert.equal(composePrompts(NEW), 1);
});
