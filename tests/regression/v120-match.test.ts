/** v1.20.0 — Matching tab: guests (not registered) see 5 random FICTIONAL-member cards and nothing else. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: handler } = await import("../../api/miniapp.js");
const { botApi } = await import("../../src/services/miniapp.js");
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { ensureChatRequestIndexes } = await import("../../src/db/models/chatRequest.js");
const { setGiftPrice, setGiftUnique, getMiniSettings } = await import("../../src/services/nava/settings.js");
const { addCustomGift, removeCustomGift } = await import("../../src/services/nava/giftDefs.js");

const api: Array<{ method: string; payload: any }> = [];
botApi().config.use(async (_prev: any, method: string, payload: any) => {
  api.push({ method, payload });
  let result: any = true;
  if (/^send/.test(method)) result = { message_id: 500 + api.length, date: 1, chat: { id: payload.chat_id, type: "private" }, photo: [{ file_id: "S" }] };
  else if (method === "getFile") result = { file_id: payload.file_id, file_path: "stickers/x.tgs" };
  return { ok: true, result } as any;
});
const sentApi = (method: string, chat?: number) => api.filter((c) => c.method === method && (chat === undefined || c.payload.chat_id === chat));

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}
async function get(query: Record<string, string>) {
  let status = 200; let sent: any; const headers: Record<string, string> = {};
  const res: any = { setHeader(k: string, v: string) { headers[k] = v; }, status(c: number) { status = c; return res; }, send(b: any) { sent = b; return res; }, end() { return res; }, json() { return res; } };
  await handler({ method: "GET", query } as any, res);
  return { status, sent, headers };
}

beforeEach(async () => {
  resetState();
  h.resetCalls();
  ensureSocialIndexesOnce();
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 1; i <= 8; i++) seedUser({ id: 4_000_000_000_000_000 + i, anonId: `seed_${i}`, nickname: `ممبر${i}`, age: 20 + i, city: "تهران", bio: "سلام", isSeed: true, profilePhotoFileId: `F${i}`, onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  seedUser({ id: 50, anonId: "user_REAL", nickname: "واقعی", age: 30, profilePhotoFileId: "FR", onboardingStep: "COMPLETED", relicBalance: 5 } as any);
  seedUser({ id: 60, anonId: "user_NOPE", nickname: "نیمه", onboardingStep: "GENDER_PENDING" } as any);
});

test("M1. an UNREGISTERED user gets exactly 5 cards, all from fictional members, random order across calls; no real person leaks", async () => {
  const a = await call(60, { action: "guest_cards" });
  assert.equal(a.status, 200);
  assert.equal(a.payload.cards.length, 5);
  for (const c of a.payload.cards) {
    assert.match(c.id, /^seed_/);
    assert.ok(c.av && c.av.startsWith("/api/miniapp?u="), "signed avatar url");
    assert.ok(!JSON.stringify(c).includes("user_REAL"));
  }
  assert.equal(new Set(a.payload.cards.map((c: any) => c.id)).size, 5);
  const orders = new Set<string>();
  for (let i = 0; i < 8; i++) orders.add((await call(60, { action: "guest_cards" })).payload.cards.map((c: any) => c.id).join(","));
  assert.ok(orders.size > 1, "random");
});

test("M2. a guest cannot do anything else: like / profile / explore / gifts are refused with not_registered", async () => {
  for (const action of ["like", "profile", "explore", "gifts", "home", "match_cards", "gift_send"]) {
    const r = await call(60, { action, id: "seed_1", pid: "pp:seed_1" });
    assert.equal(r.status, 403, action);
    assert.equal(r.payload.error, "not_registered", action);
  }
});

test("M3. guest endpoint needs valid signed initData; a hidden or banned fictional member is never shown; fewer than 5 available -> fewer cards", async () => {
  let status = 0; const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json() { return res; }, send() { return res; }, end() { return res; } };
  await handler({ method: "POST", body: { action: "guest_cards", initData: "hash=bad&user=%7B%22id%22%3A1%7D&auth_date=1" } } as any, res);
  assert.equal(status, 401);
  for (let i = 1; i <= 6; i++) col("users").updateOne({ anonId: `seed_${i}` }, { $set: { seedHidden: true } });
  const r = await call(60, { action: "guest_cards" });
  assert.deepEqual(r.payload.cards.map((c: any) => c.id).sort(), ["seed_7", "seed_8"]);
});

test("M4. a registered member without an approved photo gets need_photo; with one he gets real eligible people (never himself)", async () => {
  col("users").updateOne({ _id: 50 }, { $unset: { profilePhotoFileId: "" } });
  seedUser({ id: 51, anonId: "user_R2", nickname: "دو", profilePhotoFileId: "F51", onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  const no = await call(50, { action: "match_cards" });
  assert.notEqual(no.status, 200);
  col("users").updateOne({ _id: 50 }, { $set: { profilePhotoFileId: "FR" } });
  const ok = await call(50, { action: "match_cards" });
  assert.equal(ok.status, 200);
  const ids = ok.payload.cards.map((c: any) => c.id);
  assert.ok(ids.includes("user_R2"));
  assert.ok(!ids.includes("user_REAL"));
});
