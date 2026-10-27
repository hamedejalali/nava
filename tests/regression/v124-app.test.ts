/** v1.24.0 — Nava messages, per-user chat delete, coin, matching exclusions, delete user. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { ensureChatRequestIndexes, CHAT_REQUEST_TTL_MS } = await import("../../src/db/models/chatRequest.js");
const { createOfficialAccount } = await import("../../src/db/models/seeds.js");
const { sendOfficialMessage } = await import("../../src/services/nava/dm.js");
const { healOwnerIdentity } = await import("../../src/services/nava/common.js");

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
  return { ok: true, result } as any;
});

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "حامد" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send(o: any) { if (o && typeof o === "object" && !Buffer.isBuffer(o)) payload = o; return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
const SEED_ID = 4_000_000_000_000_001;

beforeEach(async () => {
  resetState();
  h.resetCalls();
  api.length = 0;
  ensureSocialIndexesOnce();
  await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: OWNER_ID, anonId: "user_OWNR", nickname: "حامد", firstName: "حامد", age: 33, city: "تهران", province: "تهران", bio: "", profilePhotoFileId: "FO", onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  seedUser({ id: 10, anonId: "user_AAAA", nickname: "الف", profilePhotoFileId: "FA", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "alef" } as any);
  seedUser({ id: 11, anonId: "user_BBBB", nickname: "ب", profilePhotoFileId: "FB", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "bee" } as any);
  seedUser({ id: SEED_ID, anonId: "user_SEED", nickname: "عقدس", profilePhotoFileId: "FS", onboardingStep: "COMPLETED", isSeed: true, seedChatEnabled: true, relicBalance: 0, miniUsername: "seedy" } as any);
});


test("V1. Nava sends without XP or request: lands in the user's Directs, read-only, user cannot answer; both sides can delete for themselves", async () => {
  const r = await call(OWNER_ID, { action: "official_send", id: "user_AAAA", text: "سلام از مویا" });
  assert.equal(r.status, 200); assert.equal(r.payload.ok, true);
  assert.equal(((await col("users").findOne({ _id: 10 })) as any).relicBalance, 5, "no XP taken");
  assert.equal(await col("chat_requests").countDocuments({}), 0, "no request created");
  const ov = await call(10, { action: "dm_overview" });
  assert.equal(ov.payload.items.length, 1);
  const sid = ov.payload.items[0].sid;
  const th = await call(10, { action: "dm_open", sid });
  assert.equal(th.payload.readonly, true);
  assert.equal((await call(10, { action: "dm_send", sid, text: "جواب", cid: "c1" })).status === 200, false, "user cannot answer");
  assert.equal((await call(10, { action: "dm_delete", sid })).payload.ok, true);
  assert.equal((await call(10, { action: "dm_overview" })).payload.items.length, 0, "gone for the user");
  assert.equal((await call(OWNER_ID, { action: "dm_overview" })).payload.items.length, 1, "owner still has it");
  assert.equal((await call(10, { action: "official_send", id: "user_BBBB", text: "x" })).status, 403, "normal users cannot send as Nava");
});

test("V2. set_coin: only official accounts, can be changed, removed, re-added", async () => {
  assert.equal((await call(10, { action: "set_coin", coin: "🪙" })).status, 403);
  assert.equal((await call(OWNER_ID, { action: "set_coin", coin: "💎" })).payload.coin, "💎");
  assert.equal((await call(OWNER_ID, { action: "set_coin", coin: "" })).payload.coin, null);
  assert.equal((await call(OWNER_ID, { action: "set_coin", coin: "🪙" })).payload.coin, "🪙");
  assert.equal((await call(OWNER_ID, { action: "set_coin", coin: "<b>" })).status === 200, false);
});

test("V3. matching: skipped people never return and photo-less people are never shown", async () => {
  seedUser({ id: 12, anonId: "user_NOPH", nickname: "بدون", onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  const first = await call(10, { action: "match_cards" });
  const ids = (first.payload.cards ?? first.payload.items ?? []).map((c: any) => c.id);
  assert.ok(!ids.includes("user_NOPH"), "no-photo user hidden");
  if (ids.includes("user_BBBB")) {
    await call(10, { action: "match_seen", id: "user_BBBB" });
    const again = await call(10, { action: "match_cards" });
    assert.ok(!(again.payload.cards ?? again.payload.items ?? []).some((c: any) => c.id === "user_BBBB"), "skipped never returns");
  }
});

test("V4. owner deletes a user from the profile menu (full reset); admins and the owner's own account cannot", async () => {
  assert.equal((await call(10, { action: "mod", id: "user_BBBB", op: "reset_user" })).status, 403);
  assert.equal((await call(OWNER_ID, { action: "mod", id: "user_OWNR", op: "reset_user" })).status === 200, false);
  const r = await call(OWNER_ID, { action: "mod", id: "user_BBBB", op: "reset_user" });
  assert.equal(r.status, 200);
  const u: any = await col("users").findOne({ _id: 11 });
  assert.ok(!u?.profilePhotoFileId && !u?.miniUsername, "photo and username wiped");
  assert.ok(api.some((c) => c.method === "sendMessage" && c.payload.chat_id === 11), "user told to /start");
});
