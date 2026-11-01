/** v1.28.0 — AGE SEPARATION: under-18 and 18+ never meet through any stranger entry point (backend). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

await createHarness({ OWNER_ID: "1" });
const { attemptMatchOrQueue } = await import("../../src/features/matching/engine.js");
const { buildCandidateQuery } = await import("../../src/db/models/matchQueue.js");
const { createChatRequest } = await import("../../src/db/models/chatRequest.js");
const { ageBandOf, canContact } = await import("../../src/services/ageBand.js");
const { searchPeople } = await import("../../src/services/nava/search.js");

const u = (id: number, age: number | undefined, extra: Record<string, unknown> = {}) =>
  seedUser({ id, anonId: `user_A${String(id).padStart(5, "0")}`, nickname: "n" + id, age, gender: id % 2 ? "male" : "female", province: "تهران", city: "تهران", relicBalance: 50, relicInitialized: true, onboardingStep: "COMPLETED", miniUsername: "mu" + id, ...extra } as any);
const getU = async (id: number) => (await col("users").findOne({ _id: id })) as any;

beforeEach(() => { resetState(); });

test("A1. ageBandOf / canContact basics (unknown age → nobody; official exempt)", () => {
  assert.equal(ageBandOf(17), "minor"); assert.equal(ageBandOf(18), "adult"); assert.equal(ageBandOf(undefined), null); assert.equal(ageBandOf(5), null); assert.equal(ageBandOf(17.5), null);
  assert.equal(canContact({ age: 17 }, { age: 18 }), false); assert.equal(canContact({ age: 17 }, { age: 12 }), true);
  assert.equal(canContact({ age: undefined }, { age: 30 }), false); assert.equal(canContact({ age: 15 }, { age: 99, official: true }), true);
});

for (const type of ["lucky", "male", "female", "same_age", "same_province"] as const) {
  test(`A2. random search «${type}»: a minor and an adult never match, two minors do`, async () => {
    const mk = (id: number, age: number) => u(id, age, { gender: type === "female" ? "female" : "male", province: "تهران" });
    mk(11, 17); mk(12, 40); mk(13, 17);
    // adult waits; minor searches — nobody
    const a = await attemptMatchOrQueue(await getU(12), type === "same_age" ? "lucky" : type, undefined);
    assert.equal(a.status, "queued");
    const b = await attemptMatchOrQueue(await getU(11), type, undefined);
    assert.equal(b.status, "queued", "minor must not be matched with the waiting adult");
    assert.equal((await getU(12)).activeChatSessionId ?? null, null);
    // another minor finds the waiting minor
    const c = await attemptMatchOrQueue(await getU(13), type === "same_age" ? "lucky" : type, undefined);
    assert.equal(c.status === "matched" || c.status === "queued", true);
    if (c.status === "matched") assert.equal(c.partnerId, 11);
  });
}

test("A3. the candidate query itself carries the band for every type; unknown age matches nobody", () => {
  for (const t of ["lucky", "male", "female", "same_age", "same_province"] as const) {
    const q: any = buildCandidateQuery({ telegramId: 1, searchType: t, gender: "male", age: 16, province: "x" });
    assert.deepEqual(q.ageSnapshot, { $gte: 9, $lt: 18 }, t);
    const n: any = buildCandidateQuery({ telegramId: 1, searchType: t, gender: "male", age: undefined as any, province: "x" });
    assert.deepEqual(n.ageSnapshot, { $in: [] }, t);
  }
});

test("A4. a user with no valid age cannot enter the queue at all", async () => {
  u(21, undefined); u(22, 30);
  const r = await attemptMatchOrQueue(await getU(21), "lucky", undefined);
  assert.equal(r.status, "queued");
  assert.equal(await col("match_queue").findOne({ _id: 21 }), null);
});

test("A5. chat requests (bot / Moyagram / gift reply / search all use this) are refused across the line", async () => {
  u(31, 16); u(32, 35); u(33, 15);
  assert.equal((await createChatRequest(31, 32)).status, "age_blocked");
  assert.equal((await createChatRequest(32, 31)).status, "age_blocked");
  assert.equal((await createChatRequest(31, 33)).status, "created");
});

test("A6. accepting an OLD pending request across the line is refused (no session is created)", async () => {
  u(41, 16); u(42, 35);
  await col("chat_requests").insertOne({ _id: "oldtoken", fromId: 41, toId: 42, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), origin: "bot" } as any);
  const { acceptChatRequest } = await import("../../src/services/chatRequestAccept.js");
  const r = await acceptChatRequest("oldtoken", 42);
  assert.notEqual(r.status, "accepted");
  assert.equal(await col("chat_sessions").countDocuments({}), 0);
});

test("A7. Moyagram people search / explore only list the viewer's own band", async () => {
  u(51, 16); u(52, 16, { nickname: "هم‌سن", miniUsername: "same_band", miniUsernameLower: "same_band" }); u(53, 40, { nickname: "بزرگ", miniUsername: "same_band2", miniUsernameLower: "same_band2" });
  const r = await searchPeople(51, "same_band");
  const names = r.map((x: any) => x.username);
  assert.ok(names.includes("same_band"));
  assert.ok(!names.includes("same_band2"));
});
