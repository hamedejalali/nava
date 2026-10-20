/** v1.21.0 — random seed greetings (sometimes two messages) and "each default member connects to a real person only once". (mocked) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.CRON_SECRET ||= "cron";
installFakeMongo();
const Seeds = await import("../../src/db/models/seeds.js");
const SM = await import("../../src/features/matching/seedMatch.js");
const { isSeedId } = await import("../../src/services/seeds/ids.js");
const { seedGuardTransformer } = await import("../../src/services/seeds/guard.js");
const Maint = await import("../../src/services/maintenance.js");
const Settings = await import("../../src/db/models/settings.js");
const F = await import("../../src/services/nava/follow.js");
const { getUser } = await import("../../src/db/models/user.js");

beforeEach(() => resetFakeMongo());
function fakeApi() {
  const calls: { m: string; a: any[] }[] = [];
  const mk = (m: string) => async (...a: any[]) => { calls.push({ m, a }); return { message_id: 1 }; };
  const api: any = { sendMessage: mk("sendMessage"), deleteMessage: mk("deleteMessage"), editMessageText: mk("editMessageText"), sendPhoto: mk("sendPhoto"), sendChatAction: mk("sendChatAction") };
  return { api, calls, to: (id: number) => calls.filter((c) => c.m === "sendMessage" && c.a[0] === id) };
}
const real = (id: number, extra: any = {}) => seedUser({ id, gender: "male", age: 25, province: "تهران", relicBalance: 10, relicInitialized: true, ...extra });
const mkSeed = (extra: any = {}) => Seeds.createSeed({ nickname: "مریم", gender: "female", age: 25, province: "تهران", city: "تهران", bio: "سلام", ...extra });

test("G1. greetings: usually one message, sometimes two (second after a pause); always non-empty, varied", () => {
  const seen = new Set<string>(); let two = 0; const N = 2000;
  for (let i = 0; i < N; i++) { const g = SM.pickGreeting(); assert.ok(g.length >= 1 && g.length <= 2 && g.every((x) => x.trim().length > 0)); if (g.length === 2) two++; seen.add(g.join("|")); }
  assert.ok(two / N > 0.25 && two / N < 0.45, `about a third are two-part (got ${two / N})`);
  assert.ok(seen.size > 15, "many different openers");
  assert.equal(SM.pickGreeting(() => 0.99).length, 1);
  assert.equal(SM.pickGreeting(() => 0.0).length, 2);
});

test("G2. a two-part greeting really sends two messages to the real user (typing in between) and counts both", async () => {
  const u = real(1); await Seeds.setSeedChatEnabled(true); await mkSeed();
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
  const f = fakeApi();
  const r: any = await SM.trySeedMatch(f.api, u, "girl", undefined, { rnd: () => 0.5 });
  col("seed_chat_jobs").updateOne({ _id: r.sessionId }, { $set: { greetAt: new Date(), endAt: new Date(Date.now() + 50) } });
  f.calls.length = 0;
  await SM.runSeedScript(f.api, r.sessionId, { rnd: () => 0.0, sleepFn: () => Promise.resolve() });
  const texts = f.to(1).map((c) => String(c.a[1]));
  assert.ok(texts.length >= 2, "greeting parts + notices");
  assert.equal(texts[0], SM.DOUBLE_GREETINGS[0]![0]);
  assert.equal(texts[1], SM.DOUBLE_GREETINGS[0]![1]);
  assert.ok(f.calls.some((c) => c.m === "sendChatAction"));
});

test("G3. each default member connects to the same real person ONLY ONCE, ever; when all were used the search just ends normally", async () => {
  const u = real(1); await Seeds.setSeedChatEnabled(true);
  const a = await mkSeed({ nickname: "الف" }); const b = await mkSeed({ nickname: "ب" });
  const used: number[] = [];
  for (let i = 0; i < 2; i++) {
    col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
    const f = fakeApi();
    const r: any = await SM.trySeedMatch(f.api, u, "girl", undefined);
    assert.equal(r.status, "matched");
    used.push(r.seed._id);
    col("seed_chat_jobs").updateOne({ _id: r.sessionId }, { $set: { endAt: new Date(Date.now() - 1000) } });
    await SM.processDueSeedJobs(f.api, 10, 0);
    col("users").updateOne({ _id: 1 }, { $set: { activeChatSessionId: null } });
  }
  assert.deepEqual(used.sort(), [a._id, b._id].sort(), "two different members");
  // even long after (no 24 h window any more) the same members are not offered again
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
  const none = await SM.trySeedMatch(fakeApi().api, u, "girl", undefined);
  assert.equal(none.status, "none");
  assert.ok(col("match_queue").byId(1), "still queued, nothing consumed");
  // another real person can still get them
  real(2);
  col("match_queue").insertOne({ _id: 2, userId: 2, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
  assert.equal((await SM.trySeedMatch(fakeApi().api, col("users").byId(2) as any, "girl", undefined)).status, "matched");
});

test("G4. two parallel searches of the same person can never take the same member twice", async () => {
  const u = real(1); await Seeds.setSeedChatEnabled(true); await mkSeed();
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
  const rs = await Promise.all([SM.trySeedMatch(fakeApi().api, u, "girl", undefined), SM.trySeedMatch(fakeApi().api, u, "girl", undefined)]);
  assert.equal(rs.filter((r) => r.status === "matched").length, 1);
  assert.equal(col("seed_user_pairs").all().length, 1);
});
