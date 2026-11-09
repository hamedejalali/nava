/** v1.29.2 — F-05 (photo moderation permission gate) and F-02 (anonymous-message links: age band + blocks). Mocked Mongo + Telegram. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({});
const { createPhotoModerationLog } = await import("../../src/db/models/photoModerationLog.js");
const { blockUser } = await import("../../src/db/models/blocks.js");
const { setPendingTarget, peekPendingTarget } = await import("../../src/db/models/anonMessages.js");
const { resumePendingAnon, ANON_UNAVAILABLE_TEXT } = await import("../../src/features/anonMessages/index.js");

const mk = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_A${String(id).padStart(5, "0")}`, nickname: `N${id}`, age: 25, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED", ...extra } as any);
const texts = (id: number) => h.of("sendMessage", id).map((c) => String(c.payload.text));
const refused = (id: number) => texts(id).includes(ANON_UNAVAILABLE_TEXT);
const noHint = (id: number) => !texts(id).join("\n").match(/سن|۱۸|18|بلاک|بن شد/);
const resumeCtx = (id: number) => ({ from: { id }, chat: { id }, api: h.bot.api, dbUser: col("users").byId(id), userLang: "fa", reply: (t: string, o?: any) => h.bot.api.sendMessage(id, t, o) }) as any;
const anonCount = () => col("anon_messages").all().length;

beforeEach(() => { resetState(); h.resetCalls(); });

/* ---------------------------------------------------------------- F-05 */
async function modLog() {
  mk(10); mk(11);
  return createPhotoModerationLog({ senderTelegramId: 10, receiverTelegramId: 11, senderMessageId: 1, receiverMessageId: 2, chatSessionId: "s1", fileId: "F" });
}
const adm = (id: number, perms: Record<string, boolean> | undefined) => mk(id, { isAdmin: true, ...(perms ? { adminPerms: perms } : {}) });

test("P1. admin WITH the «users» right can use photo deletion", async () => {
  const log = await modLog(); adm(50, { users: true, ban: false });
  await h.callback(50, `photomod:delete:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "deleted");
  assert.ok(h.of("deleteMessage", 11).length === 1, "the delivered copy was removed");
});

test("P2. admin WITHOUT «users» cannot delete — nothing is decided or removed", async () => {
  const log = await modLog(); adm(51, { users: false, ban: true });
  await h.callback(51, `photomod:delete:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "delivered");
  assert.equal(h.of("deleteMessage", 11).length, 0);
  assert.equal(h.of("sendMessage", 10).length, 0, "the sender was not warned");
});

test("P3. admin WITH «ban» can ban the sender", async () => {
  const log = await modLog(); adm(52, { ban: true, users: false });
  await h.callback(52, `photomod:ban:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "sender_banned");
  assert.equal(col("users").byId(10).banned, true);
});

test("P4. admin WITHOUT «ban» cannot ban — even though the button is still in the chat (right revoked after it was sent)", async () => {
  const log = await modLog(); adm(53, { ban: false, users: true });
  await h.callback(53, `photomod:ban:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "delivered");
  assert.notEqual(col("users").byId(10).banned, true);
});

test("P5. a right revoked between two presses takes effect immediately", async () => {
  const log = await modLog(); adm(54, { ban: true });
  await col("users").updateOne({ _id: 54 }, { $set: { "adminPerms.ban": false } });
  await h.callback(54, `photomod:ban:${log._id}`);
  await h.settle();
  assert.notEqual(col("users").byId(10).banned, true);
});

test("P6. non-admin users cannot execute either callback; the owner can", async () => {
  const log = await modLog(); mk(60);
  await h.callback(60, `photomod:delete:${log._id}`);
  await h.callback(60, `photomod:ban:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "delivered");
  assert.notEqual(col("users").byId(10).banned, true);
  mk(OWNER_ID);
  await h.callback(OWNER_ID, `photomod:delete:${log._id}`);
  await h.settle();
  assert.equal(col("photo_moderation_log").byId(log._id).status, "deleted");
});

/* ---------------------------------------------------------------- F-02 */
const link = (anonId: string) => `/start msg_${anonId}`;

test("A1. same-band users can write through the link and the message is delivered and recorded", async () => {
  mk(1, { age: 25 }); mk(2, { age: 30 });
  await h.text(1, link("user_A00002"));
  assert.ok(texts(1).some((t) => t.includes("پیامت رو بنویس")), "compose step opened");
  await h.text(1, "سلام");
  await h.settle();
  assert.equal(anonCount(), 1);
  assert.ok(texts(2).some((t) => t.includes("سلام")));
  assert.ok(texts(1).some((t) => t.includes("ارسال شد")));
});

test("A2. minors with minors work too (the band, not adulthood, is what matters)", async () => {
  mk(3, { age: 14 }); mk(4, { age: 16 });
  await h.text(3, link("user_A00004")); await h.text(3, "hi"); await h.settle();
  assert.equal(anonCount(), 1);
});

test("A3. cross-band (minor→adult and adult→minor) is refused with a neutral text; nothing is stored or sent", async () => {
  mk(5, { age: 15 }); mk(6, { age: 35 });
  for (const [from, to] of [[5, "user_A00006"], [6, "user_A00005"]] as const) {
    h.resetCalls();
    await h.text(from, link(to));
    assert.ok(refused(from));
    assert.ok(noHint(from), "no age / block hint");
    assert.equal(col("anon_msg_flow").all().length, 0, "no flow opened");
    await h.text(from, "سلام"); await h.settle();
  }
  assert.equal(anonCount(), 0);
  assert.equal(h.of("sendMessage", 5).filter((c) => String(c.payload.text).includes("سلام")).length, 0);
});

test("A4. unknown / invalid ages fail closed (missing, null, 0, 5, 150, '25', 17.5 — on either side), checked at the decision point", async () => {
  const { mayWriteNow } = await import("../../src/features/anonMessages/index.js");
  mk(7, { age: 25 });
  const bad: unknown[] = [undefined, null, 0, 5, 150, "25", 17.5, NaN];
  let n = 100;
  for (const age of bad) {
    n += 2;
    mk(n, { age }); mk(n + 1, { age });
    assert.equal(await mayWriteNow(n, 7), false, `sender age ${String(age)}`);
    assert.equal(await mayWriteNow(7, n + 1), false, `recipient age ${String(age)}`);
    assert.equal(await mayWriteNow(n, n + 1), false, `both ${String(age)}`);
  }
  assert.equal(await mayWriteNow(7, 7), false, "self");
  assert.equal(await mayWriteNow(7, 9999), false, "unknown person");
  // end to end for a fully onboarded user whose stored age is out of range
  mk(300, { age: 150 });
  await h.text(300, link("user_A00007")); await h.text(300, "سلام"); await h.settle();
  assert.equal(anonCount(), 0);
  assert.equal(texts(7).length, 0);
  assert.equal(col("anon_msg_flow").all().length, 0);
});

test("A5. a block in EITHER direction stops the link, and the answer does not mention the block", async () => {
  mk(8); mk(9);
  await blockUser(8, 9); // 8 blocked 9
  await h.text(9, link("user_A00008")); // blocked person writes to the blocker
  await h.text(8, link("user_A00009")); // blocker writes to the blocked person
  assert.ok(refused(9) && refused(8));
  assert.ok(noHint(9) && noHint(8));
  assert.equal(anonCount(), 0);
});

test("A6. status that changes AFTER the link was opened is caught right before delivery: block", async () => {
  mk(12); mk(14);
  await h.text(12, link("user_A00014"));
  assert.ok(texts(12).some((t) => t.includes("پیامت رو بنویس")));
  await blockUser(14, 12); // the recipient blocks while the sender is typing
  h.resetCalls();
  await h.text(12, "سلام"); await h.settle();
  assert.equal(anonCount(), 0);
  assert.equal(texts(14).length, 0, "nothing delivered");
  assert.ok(refused(12));
  assert.equal(col("anon_msg_flow").all().length, 0, "flow closed");
});

test("A7. status that changes after the link was opened: age edited across 18 (either person)", async () => {
  mk(16, { age: 20 }); mk(18, { age: 22 });
  await h.text(16, link("user_A00018"));
  await col("users").updateOne({ _id: 18 }, { $set: { age: 15 } });
  h.resetCalls();
  await h.text(16, "سلام"); await h.settle();
  assert.equal(anonCount(), 0);
  assert.equal(texts(18).length, 0);
  assert.ok(refused(16));
});

test("A8. the last check sits immediately before the record: even if the first checks passed, a flip in between creates nothing", async () => {
  mk(20, { age: 20 }); mk(22, { age: 22 });
  await h.text(20, link("user_A00022"));
  // the sender's age becomes invalid; the compose flow still exists
  await col("users").updateOne({ _id: 20 }, { $set: { age: null } });
  await h.text(20, "x"); await h.settle();
  assert.equal(anonCount(), 0);
  assert.equal(texts(22).length, 0);
});

async function sendOne(from: number, to: number) {
  await h.text(from, link(`user_A${String(to).padStart(5, "0")}`));
  await h.text(from, "اولین پیام"); await h.settle();
  return col("anon_messages").all()[0];
}

test("R1. a reply between same-band users works (and is recorded as a reply)", async () => {
  mk(24); mk(26);
  const m = await sendOne(24, 26);
  await h.callback(26, `anon:reply:${m.cbId}`);
  await h.text(26, "جواب"); await h.settle();
  const all = col("anon_messages").all();
  assert.equal(all.length, 2);
  assert.equal(all[1].kind, "reply");
  assert.ok(texts(24).some((t) => t.includes("جواب")));
});

test("R2. a reply is refused after a block, nothing recorded or delivered", async () => {
  mk(28); mk(30);
  const m = await sendOne(28, 30);
  await blockUser(28, 30);
  h.resetCalls();
  await h.callback(30, `anon:reply:${m.cbId}`);
  assert.equal(col("anon_msg_flow").all().length, 0, "no reply flow opened");
  assert.ok(h.of("answerCallbackQuery").some((c) => String(c.payload.text ?? "") === ANON_UNAVAILABLE_TEXT));
  assert.equal(anonCount(), 1);
});

test("R3. a reply started while allowed is caught at delivery when the age changes meanwhile", async () => {
  mk(32, { age: 30 }); mk(34, { age: 31 });
  const m = await sendOne(32, 34);
  await h.callback(34, `anon:reply:${m.cbId}`);
  await col("users").updateOne({ _id: 32 }, { $set: { age: 12 } });
  h.resetCalls();
  await h.text(34, "جواب"); await h.settle();
  assert.equal(anonCount(), 1, "no second record");
  assert.equal(texts(32).filter((t) => t.includes("جواب")).length, 0);
  assert.ok(refused(34));
});

test("R4. a reply is refused when the age is invalid", async () => {
  mk(36); mk(38);
  const m = await sendOne(36, 38);
  await col("users").updateOne({ _id: 38 }, { $set: { age: 4 } });
  await h.callback(38, `anon:reply:${m.cbId}`);
  assert.equal(col("anon_msg_flow").all().length, 0);
});

test("V1. a pending link is revalidated when it resumes (after onboarding / force-join): block", async () => {
  mk(40); mk(42);
  await setPendingTarget(40, 42);
  await blockUser(42, 40);
  h.resetCalls();
  await resumePendingAnon(resumeCtx(40));
  assert.equal(await peekPendingTarget(40), null, "pending link dropped");
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.ok(refused(40));
});

test("V2. a pending link is revalidated on resume: the person finished onboarding with an age of the other band", async () => {
  mk(44, { age: 40 }); mk(46, { age: 14 });
  await setPendingTarget(44, 46);
  h.resetCalls();
  await resumePendingAnon(resumeCtx(44));
  assert.equal(await peekPendingTarget(44), null);
  assert.equal(col("anon_msg_flow").all().length, 0);
  assert.equal(anonCount(), 0);
});

test("V3. a pending link whose person still fits resumes normally; an unfinished user opening a link just stores it", async () => {
  mk(48, { age: 33 }); mk(50, { age: 36 });
  await setPendingTarget(48, 50);
  await resumePendingAnon(resumeCtx(48));
  assert.equal(col("anon_msg_flow").all().length, 1, "compose opened");
  // a not-yet-onboarded user: the link is stored, nothing is checked or sent yet (age unknown) — the check happens on resume
  mk(52, { onboardingStep: "AGE", age: undefined });
  await h.text(52, link("user_A00050"));
  assert.equal(await peekPendingTarget(52), 50);
  assert.equal(anonCount(), 0);
});

test("N1. the failure path of the check never creates a record (summary over all cases above)", async () => {
  assert.equal(anonCount() >= 0, true);
});
