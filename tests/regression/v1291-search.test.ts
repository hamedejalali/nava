/** v1.29.1 — «به یه ناشناس وصلم کن»: steady timer, no frozen status messages, TTL race, two simultaneous searchers + a third user. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ OWNER_ID: "1" });
const S = await import("../../src/features/matching/search.js");
const E = await import("../../src/features/matching/engine.js");
const N = await import("../../src/db/models/searchNotice.js");

const user = (id: number, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_S${String(id).padStart(5, "0")}`, nickname: `U${id}`, age: 25, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 50, relicInitialized: true, onboardingStep: "COMPLETED", lastActivityAt: new Date(), ...extra } as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeApi(opts: { editDelayMs?: number; editError?: GrammyError } = {}) {
  const calls: { m: string; a: any[] }[] = [];
  const api: any = new Proxy({}, {
    get: (_t, m: string) => async (...a: any[]) => {
      calls.push({ m, a });
      if (m === "editMessageReplyMarkup") {
        if (opts.editDelayMs) await sleep(opts.editDelayMs);
        if (opts.editError) throw opts.editError;
      }
      return { message_id: 1 };
    },
  });
  return { api, calls };
}
const shown = (calls: { m: string; a: any[] }[]) =>
  calls.filter((c) => c.m === "editMessageReplyMarkup").map((c) => String(c.a[2].reply_markup.inline_keyboard[0][0].text));

async function queueUp(id: number, type: string, extra: Record<string, unknown> = {}) {
  const u = col("users").byId(id);
  const doc = { _id: id, searchType: type, genderSnapshot: u.gender, ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 500 + id, createdAt: new Date(), expiresAt: new Date(Date.now() + 40_000), ...extra };
  await col("match_queue").insertOne(doc as any);
  await N.armSearchNotice(id, doc.createdAt as Date, doc.expiresAt as Date, 500 + id);
  return doc;
}

beforeEach(() => { resetState(); h.resetCalls(); user(1); user(2); user(3); user(4); });

test("T1. the shown number is a steady grid (1,2,3…) even when every Telegram edit is slow — no 1,3,4,6 jumps", async () => {
  await queueUp(1, "female");
  const { api, calls } = fakeApi({ editDelayMs: 350 });
  await S.runCountdown(api, col("users").byId(1), 1, 501, "fa", "female", { totalMs: 4200, tickMs: 1000, noSeed: true });
  const nums = shown(calls).map((t) => Number(t.replace(/\D/g, "")));
  assert.deepEqual(nums, [1, 2, 3, 4], nums.join(","));
});

test("T2. the clock runs from the person's press: the deadline is press+40 s, never later than the queue entry's own expiry", async () => {
  await queueUp(1, "female");
  const { api } = fakeApi();
  const pressed = Date.now() - 300; // the webhook did 300 ms of work before the countdown could start
  const t0 = Date.now();
  await S.runCountdown(api, col("users").byId(1), 1, 501, "fa", "female", { totalMs: 700, tickMs: 100, noSeed: true, searchStartedAt: pressed });
  const took = Date.now() - t0;
  assert.ok(took >= 350 && took < 600, `took ${took}ms (should be ~400, not 700)`);
});

test("T3. the status message deleted by the user does NOT kill the search: it still matches a later partner and still times out properly", async () => {
  await queueUp(1, "female");
  const err = new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } as any, "editMessageReplyMarkup", {});
  const { api, calls } = fakeApi({ editError: err });
  const run = S.runCountdown(api, col("users").byId(1), 1, 501, "fa", "female", { totalMs: 700, tickMs: 100, noSeed: true });
  await sleep(250);
  await queueUp(2, "male"); // a compatible partner arrives after the number stopped being editable
  await run;
  assert.equal(col("chat_sessions").all().length, 1, "matched although the number could not be edited");
  assert.equal(shown(calls).length, 1, "edit attempts stop after the first 400");
  // and a lone searcher with a deleted status message still gets the timeout notice
  resetState();
  user(1);
  await queueUp(1, "female");
  const second = fakeApi({ editError: err });
  await S.runCountdown(second.api, col("users").byId(1), 1, 501, "fa", "female", { totalMs: 400, tickMs: 100, noSeed: true });
  assert.ok(second.calls.some((c) => c.m === "sendMessage" && c.a[0] === 1), "timeout notice sent");
  assert.equal(col("match_queue").all().length, 0);
});

test("T4. TTL swept the queue entry a moment before the deadline: the countdown still declares the timeout (notice + status removal)", async () => {
  await queueUp(1, "female");
  const { api, calls } = fakeApi();
  const run = S.runCountdown(api, col("users").byId(1), 1, 501, "fa", "female", { totalMs: 500, tickMs: 100, noSeed: true });
  await sleep(150);
  col("match_queue").rawDocs.clear(); // exactly what MongoDB's TTL monitor does: removes the document, voids nothing
  await run;
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 501), "frozen status message removed");
  assert.ok(calls.some((c) => c.m === "sendMessage" && c.a[0] === 1), "timeout notice delivered");
  const notices = col("search_notices").all();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].state, "sent");
});

test("T5. matched by the other side while this person's status message id was unknown to the matcher: the countdown removes its own frozen message", async () => {
  await queueUp(1, "female");
  const { api, calls } = fakeApi();
  const run = S.runCountdown(api, col("users").byId(1), 1, 777, "fa", "female", { totalMs: 600, tickMs: 100, noSeed: true });
  await sleep(120);
  // the partner's transaction removed the entry (and voided the notice) but deleted a DIFFERENT / unknown status id
  await col("match_queue").deleteOne({ _id: 1 });
  await N.voidSearchNotices([1]);
  await run;
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 777), "own status removed");
  assert.ok(!calls.some((c) => c.m === "sendMessage"), "no timeout notice after a match");
});

test("T6. pressing twice quickly: the OLDER countdown removes its own message and stays silent (the newer search owns the entry)", async () => {
  await queueUp(1, "female");
  const { api, calls } = fakeApi();
  const run = S.runCountdown(api, col("users").byId(1), 1, 111, "fa", "female", { totalMs: 600, tickMs: 100, noSeed: true });
  await sleep(150);
  await col("match_queue").deleteOne({ _id: 1 }); // the second press re-queues: new document, new createdAt
  await N.armSearchNotice(1, new Date(Date.now() + 5), new Date(Date.now() + 40_000), 222);
  await col("match_queue").insertOne({ _id: 1, searchType: "female", genderSnapshot: "male", ageSnapshot: 25, provinceSnapshot: "تهران", statusMessageId: 222, createdAt: new Date(Date.now() + 5), expiresAt: new Date(Date.now() + 40_000) } as any);
  await run;
  assert.ok(calls.some((c) => c.m === "deleteMessage" && c.a[1] === 111), "old status removed");
  assert.ok(!calls.some((c) => c.m === "sendMessage"), "no timeout notice for the replaced search");
  assert.equal(col("match_queue").all().length, 1, "the newer search is untouched");
});

test("T7. two people press at the same instant with opposite genders, a third user taps a button meanwhile: the pair is connected, the third is served", async () => {
  for (let round = 0; round < 5; round++) {
    resetState(); h.resetCalls(); user(11); user(12); user(13);
    await Promise.all([h.callback(11, "match:female"), h.callback(12, "match:male"), h.callback(13, "menu:connect_anonymous")]);
    await h.settle();
    const sessions = col("chat_sessions").all();
    assert.equal(sessions.length, 1, `round ${round}`);
    assert.deepEqual([sessions[0].userA, sessions[0].userB].sort(), [11, 12]);
    assert.equal(col("match_queue").all().length, 0);
    for (const id of [11, 12]) {
      const found = h.of("sendMessage", id).filter((c) => String(c.payload.text).includes("پیدا کردم"));
      assert.equal(found.length, 1, `user ${id} got exactly one «connected» message`);
      // any status message that was shown is gone
      const statusIds = h.of("sendMessage", id).filter((c) => String(c.payload.text).includes("جستجو")).map((c) => c.resultMessageId);
      const deleted = new Set(h.of("deleteMessage", id).map((c) => c.payload.message_id));
      for (const sid of statusIds) assert.ok(deleted.has(sid), `user ${id}: status ${sid} removed`);
    }
    assert.ok(h.of("sendMessage", 13).some((c) => String(c.payload.text).length > 0), "the third user got the gender menu");
    assert.equal(col("users").byId(11).relicBalance, 49, "both charged the same, once");
    assert.equal(col("users").byId(12).relicBalance, 49);
    assert.equal(col("users").byId(13).relicBalance, 50);
  }
});

test("T8. two people of the same gender searching for the other gender do not break each other; both can still cancel", async () => {
  user(5); user(7);
  await Promise.all([h.callback(5, "match:female"), h.callback(7, "match:female")]);
  await h.settle();
  assert.equal(col("chat_sessions").all().length, 0);
  assert.equal(col("match_queue").all().length, 2);
  await Promise.all([h.callback(5, "search:cancel"), h.callback(7, "search:cancel")]);
  await h.settle();
  assert.equal(col("match_queue").all().length, 0);
  void E;
});
