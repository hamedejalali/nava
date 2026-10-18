/** v1.18.0 — default members, search fill, maintenance gate, private pages. (in-memory Mongo fake; Telegram mocked) */
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

test("D1. seed ids are reserved and never collide with Telegram ids", async () => {
  const s = await mkSeed(); const s2 = await mkSeed();
  assert.ok(isSeedId(s._id) && isSeedId(s2._id) && s2._id !== s._id);
  assert.equal(isSeedId(123456789), false);
  assert.equal(s.relicBalance, 0);
});

test("D2. Telegram guard: calls addressed to a default member are faked, real ones pass through", async () => {
  const s = await mkSeed();
  let passed = 0;
  const prev: any = async () => { passed++; return { ok: true, result: true }; };
  const r: any = await (seedGuardTransformer as any)(prev, "sendMessage", { chat_id: s._id, text: "x" });
  assert.equal(r.ok, true); assert.equal(passed, 0);
  await (seedGuardTransformer as any)(prev, "sendMessage", { chat_id: 5, text: "x" });
  assert.equal(passed, 1);
});

test("D3. hiding/disabling flags are mirrored onto members; new members inherit them", async () => {
  const a = await mkSeed();
  await Seeds.setSeedsHidden(true); await Seeds.setSeedChatEnabled(true);
  assert.equal((await getUser(a._id) as any).seedHidden, true);
  assert.equal((await getUser(a._id) as any).seedChatEnabled, true);
  const b = await mkSeed();
  assert.equal((b as any).seedHidden, true); assert.equal((b as any).seedChatEnabled, true);
});

test("D4. search fill: connects, greets, shows the profile-viewed notice, ends, announces once; no money moves", async () => {
  const u = real(1); await Seeds.setSeedChatEnabled(true); const s = await mkSeed();
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date(Date.now() - 30_000) } as any);
  const f = fakeApi();
  const r = await SM.trySeedMatch(f.api, u, "girl", undefined, { rnd: () => 0.5 });
  assert.equal(r.status, "matched");
  assert.equal(col("match_queue").byId(1), undefined);
  assert.equal(col("users").byId(s._id).activeChatSessionId, col("users").byId(1).activeChatSessionId);
  const sessionId = (r as any).sessionId;
  col("seed_chat_jobs").updateOne({ _id: sessionId }, { $set: { greetAt: new Date(), endAt: new Date(Date.now() + 50) } });
  await SM.runSeedScript(f.api, sessionId, { rnd: () => 0.5, sleepFn: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20))) });
  const texts = f.to(1).map((c) => String(c.a[1]));
  assert.ok(texts.some((t) => t.includes("پروفایل")), "profile-viewed notice sent to the real user");
  assert.equal(col("users").byId(1).activeChatSessionId ?? null, null);
  assert.equal(col("users").byId(s._id).activeChatSessionId ?? null, null);
  assert.equal(col("users").byId(1).relicBalance, 10);
  assert.equal(col("users").byId(s._id).relicBalance, 0);
  assert.equal(f.calls.filter((c) => c.m === "sendMessage" && c.a[0] === s._id).length, 0, "nothing is sent to the member's id");
  assert.equal(await SM.finalizeSeedChat(f.api, sessionId), false, "a second finalize is a no-op");
  assert.equal(col("seed_chat_log").all().length, 1);
});

test("D5. a disabled member (or a hidden-from-chat one) is never matched; nobody matches seeds with each other", async () => {
  const u = real(1); await mkSeed(); // chat disabled by default
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date() } as any);
  const r = await SM.trySeedMatch(fakeApi().api, u, "girl", undefined);
  assert.equal(r.status, "none");
  assert.ok(col("match_queue").byId(1));
});

test("D6. overdue default-member chats are finished by the sweep", async () => {
  const u = real(1); await Seeds.setSeedChatEnabled(true); await mkSeed();
  col("match_queue").insertOne({ _id: 1, userId: 1, searchType: "girl", createdAt: new Date() } as any);
  const f = fakeApi();
  const r: any = await SM.trySeedMatch(f.api, u, "girl", undefined);
  col("seed_chat_jobs").updateOne({ _id: r.sessionId }, { $set: { endAt: new Date(Date.now() - 60_000) } });
  assert.equal(await SM.processDueSeedJobs(f.api, 10, 0), 1);
  assert.equal(col("users").byId(1).activeChatSessionId ?? null, null);
});

test("M1. maintenance: only the allow-list and staff pass", async () => {
  await Settings.setMaintenanceMode(true); await Settings.setMaintenanceAllowIds([77]);
  const st = await Maint.getMaintenanceState();
  assert.equal(Maint.maintenanceAllows(st, 77, null), true);
  assert.equal(Maint.maintenanceAllows(st, 78, null), false);
  assert.equal(Maint.maintenanceAllows(st, 78, { isAdmin: true }), true);
  await Settings.setMaintenanceMode(false);
  assert.equal(Maint.maintenanceAllows(await Maint.getMaintenanceState(), 78, null), true);
});

test("P1. private page: follow becomes a request, approval makes the follow, going public approves the rest", async () => {
  const owner = real(1, { anonId: "user_OWN1", isPrivate: true, nickname: "o" });
  const v1 = real(2, { anonId: "user_V1", nickname: "a" }); const v2 = real(3, { anonId: "user_V2", nickname: "b" });
  const r = await F.setFollow(v1, "user_OWN1", true);
  assert.equal(r?.requested, true); assert.equal(r?.following, false);
  assert.equal(await F.countFollowRequests(owner._id), 1);
  const ok = await F.respondFollowRequest(owner, "user_V1", true);
  assert.equal(ok.status, "accepted"); assert.equal(ok.requests, 0);
  assert.equal(col("mini_follows").all().length, 1);
  await F.setFollow(v2, "user_OWN1", true);
  const pub = await F.setPrivate(owner, false);
  assert.equal(pub.isPrivate, false); assert.equal(pub.requests, 0);
  assert.equal(col("mini_follows").all().length, 2);
  const lists = await F.listFollows(3, "user_OWN1", "followers");
  assert.ok(lists && !lists.locked);
});

test("P2. a locked private page hides its follow lists from strangers", async () => {
  real(1, { anonId: "user_OWN1", isPrivate: true, nickname: "o" }); real(2, { anonId: "user_V1", nickname: "a" });
  const l = await F.listFollows(2, "user_OWN1", "followers");
  assert.equal(l?.locked, true); assert.equal(l?.items.length, 0);
});
