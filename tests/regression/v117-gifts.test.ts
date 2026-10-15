/** v1.17.0 — gifts: anonymous sender, unique (single-copy) gifts, re-gifting, Telegram-sticker gifts, "message the sender" button. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
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
  api.length = 0;
  ensureSocialIndexesOnce();
  await ensureChatRequestIndexes();
  await new Promise((r) => setTimeout(r, 20));
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", relicBalance: 200, relicInitialized: true, miniUsername: "ali", miniUsernameLower: "ali" });
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", relicBalance: 200, relicInitialized: true, miniUsername: "sara", miniUsernameLower: "sara" });
  seedUser({ id: 3, anonId: "user_AAA3", nickname: "نیما", relicBalance: 200, relicInitialized: true });
});

test("G1. anonymous gift: receiver sees «ناشناس», no sender name/id anywhere, and NO reply button", async () => {
  const r = await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cake", clientId: "anon-0001", anonymous: true, message: "سورپرایز" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.gift.from, null);
  assert.equal(r.payload.gift.anonymous, true);
  const note = sentApi("sendMessage", 2)[0]!.payload;
  assert.match(note.text, /ناشناس/);
  assert.doesNotMatch(note.text, /ali|علی/);
  assert.equal(note.reply_markup, undefined);
  const list = (await call(2, { action: "gifts", id: "user_AAA2" })).payload;
  assert.equal(list.items[0].from, null);
  assert.equal(JSON.stringify(list).includes("user_AAA1"), false);
  assert.equal(JSON.stringify(list).includes("علی"), false);
});

test("G2. named gift: public id is opaque (no Telegram id inside); notification carries the «پیام به فرستنده» button", async () => {
  const r = await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cake", clientId: "named-001" });
  const pub = col("mini_gifts").all()[0].pub as string;
  assert.ok(pub && pub.length >= 6);
  assert.equal(r.payload.gift.id, pub);
  assert.doesNotMatch(r.payload.gift.id, /^1:/);
  const note = sentApi("sendMessage", 2)[0]!.payload;
  const btn = note.reply_markup.inline_keyboard.flat()[0];
  assert.equal(btn.callback_data, `gr:${pub}`);
  assert.match(btn.text, /پیام به فرستنده/);
  const list = (await call(2, { action: "gifts", id: "user_AAA2" })).payload;
  assert.equal(list.items[0].id, pub);
  assert.equal(list.items[0].from.name, "علی");
});

test("G3. a UNIQUE gift can be bought only once; a race between two buyers gives it to exactly one and charges once", async () => {
  await setGiftUnique("crown", true);
  const cat = (await call(1, { action: "gift_catalog" })).payload.items;
  assert.deepEqual([cat.find((g: any) => g.id === "crown").unique, cat.find((g: any) => g.id === "crown").soldOut], [true, false]);
  const race = await Promise.all([
    call(1, { action: "gift_send", id: "user_AAA3", giftId: "crown", clientId: "uniq-race-1" }),
    call(2, { action: "gift_send", id: "user_AAA3", giftId: "crown", clientId: "uniq-race-2" }),
  ]);
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
  assert.equal(race.find((x) => x.status === 409)!.payload.error, "sold_out");
  assert.equal(col("mini_gifts").all().length, 1);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "GIFT_SENT").length, 1);
  const balances = [col("users").byId(1).relicBalance, col("users").byId(2).relicBalance].sort();
  assert.deepEqual(balances, [100, 200], "only the winner paid (100)");
  const after = (await call(1, { action: "gift_catalog" })).payload.items.find((g: any) => g.id === "crown");
  assert.equal(after.soldOut, true);
  // a later, sequential attempt is refused without charging
  const late = await call(3, { action: "gift_send", id: "user_AAA1", giftId: "crown", clientId: "uniq-late-1" });
  assert.equal(late.payload.error, "sold_out");
  assert.equal(col("users").byId(3).relicBalance, 200);
});

test("G4. re-gift: the owner passes a gift on for free; a non-owner can't; two parallel taps move it once; unique stays single", async () => {
  await setGiftUnique("rose", true);
  await call(1, { action: "gift_send", id: "user_AAA2", giftId: "rose", clientId: "regift-001" });
  const pub = col("mini_gifts").all()[0].pub as string;
  const bal2 = col("users").byId(2).relicBalance;

  assert.equal((await call(3, { action: "gift_regift", gift: pub, id: "user_AAA1" })).status, 404); // not the owner
  assert.equal((await call(2, { action: "gift_regift", gift: pub, id: "user_AAA2" })).payload.error, "self");

  const two = await Promise.all([
    call(2, { action: "gift_regift", gift: pub, id: "user_AAA3", message: "برای تو", anonymous: false }),
    call(2, { action: "gift_regift", gift: pub, id: "user_AAA1", message: "برای علی" }),
  ]);
  assert.deepEqual(two.map((x) => x.status).sort(), [200, 404]);
  assert.equal(col("users").byId(2).relicBalance, bal2, "re-gifting is free");
  const doc = col("mini_gifts").all()[0];
  assert.equal(col("mini_gifts").all().length, 1);
  assert.notEqual(doc.receiverId, 2);
  assert.equal(doc.senderId, 2);
  assert.equal((await call(2, { action: "gifts", id: "user_AAA2" })).payload.total, 0);
  // the unique gift is still sold out for buyers
  assert.equal((await call(3, { action: "gift_send", id: "user_AAA1", giftId: "rose", clientId: "regift-002" })).payload.error, "sold_out");
  // the new owner was told
  assert.ok(sentApi("sendMessage", doc.receiverId).length >= 1);
});

test("G5. gifts saved before v1.17 (no public id) get one when listed, and never expose their old id", async () => {
  col("mini_gifts").seed({ _id: "1:oldclient1", senderId: 1, receiverId: 2, giftId: "heart", price: 1, message: "", createdAt: new Date() } as any);
  const list = (await call(2, { action: "gifts", id: "user_AAA2" })).payload;
  assert.ok(list.items[0].id && !String(list.items[0].id).includes(":"));
  assert.equal(col("mini_gifts").all()[0].pub, list.items[0].id);
});

test("G6. Telegram-sticker gift: appears with a signed animation URL, sells at the owner's price, serves un-gzipped Lottie, rejects a forged URL", async () => {
  const g = await addCustomGift({ name: "میمون", emoji: "🐵", price: 30, sticker: { fileId: "FID", uniqueId: "UNIQ1", format: "tgs" }, createdBy: 900 });
  assert.match(g._id, /^tg[a-z0-9]{6}$/);
  const card = (await call(1, { action: "gift_catalog" })).payload.items.find((c: any) => c.id === g._id);
  assert.equal(card.price, 30);
  assert.equal(card.anim.format, "tgs");
  assert.match(card.anim.url, /^\/api\/miniapp\?g=tg[a-z0-9]{6}&v=UNIQ1&s=[0-9a-f]+$/);

  await setGiftPrice(g._id, 12);
  assert.equal((await call(1, { action: "gift_send", id: "user_AAA2", giftId: g._id, clientId: "tg-gift-001" })).payload.balance, 188);

  const lottie = JSON.stringify({ v: "5.5.2", layers: [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(gzipSync(Buffer.from(lottie)), { status: 200 })) as any;
  try {
    const q = Object.fromEntries(new URL("https://x" + card.anim.url).searchParams) as Record<string, string>;
    const ok = await get(q);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["Content-Type"], "application/json");
    assert.equal(Buffer.from(ok.sent).toString(), lottie);
    assert.equal((await get({ ...q, s: "0".repeat(24) })).status, 403);
    assert.equal((await get({ ...q, v: "OTHER" })).status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("G7. removing a custom gift: kept (switched off) when someone owns one, deleted when unused", async () => {
  const used = await addCustomGift({ name: "الف", emoji: "🐵", price: 3, sticker: { fileId: "F1", uniqueId: "U1", format: "tgs" }, createdBy: 900 });
  const unused = await addCustomGift({ name: "ب", emoji: "🐒", price: 3, sticker: { fileId: "F2", uniqueId: "U2", format: "webm" }, createdBy: 900 });
  await call(1, { action: "gift_send", id: "user_AAA2", giftId: used._id, clientId: "rm-gift-001" });
  assert.equal(await removeCustomGift(used._id), "disabled");
  assert.equal(await removeCustomGift(unused._id), "deleted");
  const cat = (await call(1, { action: "gift_catalog" })).payload;
  assert.equal(cat.items.some((c: any) => c.id === used._id), false);
  assert.equal(cat.all.some((c: any) => c.id === used._id), true, "old gifts still render");
  assert.equal((await getMiniSettings()).giftUnique[used._id], undefined);
});

test("G8. «پیام به فرستنده»: no Relic -> buy-from-wallet message; with Relic -> confirm -> chat request to the sender; nobody is charged until the sender accepts", async () => {
  await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cake", clientId: "reply-0001" });
  const pub = col("mini_gifts").all()[0].pub as string;

  // somebody else cannot use the button
  await h.callback(3, `gr:${pub}`);
  assert.ok(h.of("answerCallbackQuery").some((c) => /معتبر نیست/.test(String(c.payload.text))));

  // receiver without Relic
  col("users").updateOne({ _id: 2 }, { $set: { relicBalance: 0 } });
  h.resetCalls();
  await h.callback(2, `gr:${pub}`);
  assert.ok(h.of("sendMessage", 2).some((c) => /کیف پول/.test(String(c.payload.text)) && /منتقل/.test(String(c.payload.text))));
  assert.equal(col("chat_requests").all().length, 0);

  // receiver with Relic: asked to confirm, then the sender gets the request
  col("users").updateOne({ _id: 2 }, { $set: { relicBalance: 5 } });
  h.resetCalls();
  api.length = 0;
  await h.callback(2, `gr:${pub}`);
  const ask = h.of("sendMessage", 2).find((c) => /۱ رلیک/.test(String(c.payload.text)))!;
  assert.ok(ask, "confirmation asked");
  assert.equal(ask.payload.reply_markup.inline_keyboard.flat()[0].callback_data, `grc:${pub}`);
  await h.callback(2, `grc:${pub}`);
  const reqs = col("chat_requests").all();
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0].fromId, reqs[0].toId, reqs[0].status], [2, 1, "pending"]);
  assert.ok(sentApi("sendMessage", 1).concat(sentApi("sendPhoto", 1)).some((c) => JSON.stringify(c.payload.reply_markup).includes("crq:a:")));
  assert.equal(col("users").byId(2).relicBalance, 5, "not charged before acceptance");

  // the sender accepts -> both pay 1 Relic, atomically, and the chat starts
  const before1 = col("users").byId(1).relicBalance;
  await h.callback(1, `crq:a:${reqs[0]._id}`);
  assert.equal(col("users").byId(2).relicBalance, 4);
  assert.equal(col("users").byId(1).relicBalance, before1 - 1);
  assert.ok(col("chat_sessions").all().some((s: any) => s.active));
});

test("G9. an anonymous gift's button can never be used (the sender stays hidden)", async () => {
  await call(1, { action: "gift_send", id: "user_AAA2", giftId: "cake", clientId: "anon-0002", anonymous: true });
  const pub = col("mini_gifts").all()[0].pub as string;
  h.resetCalls();
  await h.callback(2, `gr:${pub}`);
  assert.ok(h.of("answerCallbackQuery").some((c) => /معتبر نیست/.test(String(c.payload.text))));
  assert.equal(col("chat_requests").all().length, 0);
});
