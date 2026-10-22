/** v1.23.0 — legal accounts, read-only Nava threads, no-expiry chat requests, acting-as accept, owner location, XP-stake backgammon. (mocked Mongo + Telegram) */
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

test("N1. chat requests do not expire; the owner (acting as a default member) can accept one", async () => {
  const rq = await call(10, { action: "request", id: "user_SEED" });
  assert.equal(rq.payload.status, "sent");
  const doc: any = await col("chat_requests").findOne({ fromId: 10 });
  assert.ok(doc.expiresAt.getTime() - Date.now() > 5 * 365 * 86_400_000, "expiry is years away");
  assert.ok(CHAT_REQUEST_TTL_MS > 5 * 365 * 86_400_000);
  const inbox = await call(OWNER_ID, { action: "dm_requests", asUser: true, actAs: "user_SEED" });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.payload.incoming.length, 1);
  const ok = await call(OWNER_ID, { action: "dm_respond", asUser: true, actAs: "user_SEED", id: inbox.payload.incoming[0].id, accept: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.status, "accepted");
  assert.equal(((await col("users").findOne({ _id: 10 })) as any).relicBalance, 4, "sender paid 1 XP only at accept time");
});

test("N2. Nava (owner) takes no chat requests; a legal account takes them only while the owner switched it on", async () => {
  assert.equal((await call(10, { action: "request", id: "user_OWNR" })).payload.status, "unavailable");
  const leg: any = await createOfficialAccount("پشتیبانی نوا");
  assert.equal(leg.official, true);
  assert.equal((await call(10, { action: "request", id: leg.anonId })).payload.status, "unavailable");
  const on = await call(OWNER_ID, { action: "official_chat", asUser: true, actAs: leg.anonId, open: true });
  assert.equal(on.payload.open, true);
  assert.equal((await call(10, { action: "request", id: leg.anonId })).payload.status, "sent");
  // ordinary users cannot flip the switch; the owner's own page has none
  assert.equal((await call(10, { action: "official_chat", open: true })).status, 403);
  assert.equal((await call(OWNER_ID, { action: "official_chat", asUser: true, open: true })).status, 403);
  // default-member switches never touch legal accounts
  const { setSeedChatEnabled } = await import("../../src/db/models/seeds.js");
  await setSeedChatEnabled(true);
  assert.equal(((await col("users").findOne({ _id: leg._id })) as any).seedChatEnabled, false);
});

test("N3. the owner can clear age / city / bio and set a place; ordinary users cannot use set_location", async () => {
  const r = await call(OWNER_ID, { action: "set_location", asUser: true, province: "", city: "" });
  assert.equal(r.status, 200);
  const u: any = await col("users").findOne({ _id: OWNER_ID });
  assert.ok(!u.city && !u.province);
  assert.equal((await call(OWNER_ID, { action: "request_change", asUser: true, field: "age", value: "" })).status, 200);
  assert.equal((await call(10, { action: "set_location", province: "x", city: "y" })).status, 403);
});

test("N4. messages from Nava arrive as a read-only thread (not a request); the user cannot answer", async () => {
  await sendOfficialMessage(botApi() as any, OWNER_ID, 10, "هشدار: لطفاً قوانین رو رعایت کن");
  const ov = await call(10, { action: "dm_overview" });
  assert.equal(ov.payload.items.length, 1);
  assert.equal(ov.payload.items[0].readonly, true);
  assert.equal(ov.payload.requests.incoming, 0);
  assert.equal(ov.payload.items[0].partner.verified, true);
  assert.equal((await call(10, { action: "pulse" })).payload.dm.unread, 1);
  const t = await call(10, { action: "dm_open", sid: ov.payload.items[0].sid });
  assert.equal(t.payload.readonly, true);
  assert.equal(t.payload.messages.length, 1);
  assert.equal((await call(10, { action: "pulse" })).payload.dm.unread, 0, "reading clears it");
  const s = await call(10, { action: "dm_send", sid: ov.payload.items[0].sid, text: "جواب" });
  assert.notEqual(s.status, 200);
  // a second notice reuses the same thread
  await sendOfficialMessage(botApi() as any, OWNER_ID, 10, "دومی");
  assert.equal((await call(10, { action: "dm_overview" })).payload.items.length, 1);
});

test("N5. owner deleting a post tells the author from Nava in a read-only thread", async () => {
  const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString("base64");
  const p = await call(10, { action: "post_create", image: PNG, caption: "x" });
  assert.equal(p.status, 200, JSON.stringify(p.payload));
  const pid = p.payload.item.pid;
  const d = await call(OWNER_ID, { action: "post_delete", asUser: true, pid, reason: "نقض قوانین" });
  assert.equal(d.status, 200);
  const ov = await call(10, { action: "dm_overview" });
  assert.equal(ov.payload.items[0]?.readonly, true);
  const t = await call(10, { action: "dm_open", sid: ov.payload.items[0].sid });
  assert.ok(/نقض قوانین/.test(t.payload.messages[0].text));
});

test("N6. the owner's real registered name is replaced by «Nava»", async () => {
  const u: any = await col("users").findOne({ _id: OWNER_ID });
  await healOwnerIdentity(u, "حامد");
  const f: any = await col("users").findOne({ _id: OWNER_ID });
  assert.equal(f.nickname, "Nava");
  assert.equal(f.firstName, "Nava");
});

test("N7. backgammon XP stakes: host's chips are held, the opponent matches, the winner takes the pot; cancel refunds; no balance → no seat", async () => {
  const bal = async (id: number) => ((await col("users").findOne({ _id: id })) as any).relicBalance as number;
  const c = await call(10, { action: "game_create", stake: 5 });
  assert.equal(c.payload.stake, 5);
  assert.equal(await bal(10), 0);
  // a poor opponent cannot sit down
  seedUser({ id: 12, anonId: "user_CCCC", nickname: "ج", profilePhotoFileId: "FC", onboardingStep: "COMPLETED", relicBalance: 2, miniUsername: "cee" } as any);
  const bad = await call(12, { action: "game_join", gid: c.payload.gid });
  assert.notEqual(bad.status, 200);
  assert.equal(await bal(12), 2);
  const j = await call(11, { action: "game_join", gid: c.payload.gid });
  assert.equal(j.status, 200);
  assert.equal(await bal(11), 0);
  // user 11 resigns → user 10 wins the whole pot, exactly once
  const r = await call(11, { action: "game_resign", gid: c.payload.gid });
  assert.equal(r.payload.status, "finished");
  assert.equal(await bal(10), 10);
  await call(11, { action: "game_state", gid: c.payload.gid });
  await call(10, { action: "game_state", gid: c.payload.gid });
  assert.equal(await bal(10), 10, "paid once");
  // an empty table that is cancelled gives the chips back
  const c2 = await call(10, { action: "game_create", stake: 2 });
  assert.equal(await bal(10), 8);
  await call(10, { action: "game_resign", gid: c2.payload.gid });
  assert.equal(await bal(10), 10);
  // not enough XP to open a table
  assert.notEqual((await call(12, { action: "game_create", stake: 50 })).status, 200);
  // friendly games move nothing
  const f = await call(10, { action: "game_create", stake: 0 });
  await call(11, { action: "game_join", gid: f.payload.gid });
  await call(11, { action: "game_resign", gid: f.payload.gid });
  assert.equal(await bal(10), 10);
  assert.equal(await bal(11), 0);
});
