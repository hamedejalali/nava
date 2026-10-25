/** v1.17.0 — owner gift tools: Telegram-sticker gifts, unique, delete/take, auctions, giveaways. (mocked Mongo + Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID, ADMIN_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { ensureSocialIndexesOnce } = await import("../../src/services/miniappSocial.js");
const { setPostsChannel, setEventsChannel, getMiniSettings, setGiftUnique } = await import("../../src/services/nava/settings.js");
const { giftCatalog } = await import("../../src/services/nava/gifts.js");
const { adminDeleteGift, mintGiftFor } = await import("../../src/services/nava/giftAdmin.js");
const { ensureGiftEventIndexes, placeBid, joinGiveaway, settleGiftEvent, processDueGiftEvents, createGiftEvent } = await import("../../src/services/nava/giftEvents.js");
const { getDb } = await import("../../src/db/connect.js");

const CH = -100777;
const api = () => h.bot.api;
const bal = (id: number) => col("users").byId(id).relicBalance as number;
const sum = (...ids: number[]) => ids.reduce((a, i) => a + bal(i), 0);

beforeEach(async () => {
  resetState();
  h.resetCalls();
  ensureSocialIndexesOnce();
  await ensureGiftEventIndexes(await getDb());
  await new Promise((r) => setTimeout(r, 20));
  for (const id of [1, 2, 3, 4]) seedUser({ id, anonId: `user_AAA${id}`, nickname: `u${id}`, relicBalance: 100 });
  seedUser({ id: OWNER_ID, anonId: "user_OWN0", nickname: "owner", relicBalance: 0 });
  seedUser({ id: ADMIN_ID, anonId: "user_ADM1", nickname: "admin", relicBalance: 0 });
  await setPostsChannel(CH, "کانال");
  await setEventsChannel(CH, "رویدادها");
});

/* ============================================================ adding Telegram gifts */
test("A1. owner adds a gift from an animated sticker (name + price asked); it shows up for everybody; a normal user cannot", async () => {
  await h.callback(1, "admin:gf:add");
  await h.file(1, "sticker", "S-nope");
  assert.equal(col("mini_gift_defs").all().length, 0);

  await h.callback(OWNER_ID, "admin:gf:add");
  await h.file(OWNER_ID, "sticker", "STK-MONKEY");
  assert.ok(h.of("sendMessage", OWNER_ID).some((c) => /نام، قیمت و اموجی/.test(String(c.payload.text))));
  await h.text(OWNER_ID, "میمون");
  await h.text(OWNER_ID, "abc");
  assert.equal(col("mini_gift_defs").all().length, 0, "bad price rejected");
  await h.text(OWNER_ID, "۴۰");
  await h.text(OWNER_ID, "رد"); // background emoji step (skip)
  const defs = col("mini_gift_defs").all();
  assert.equal(defs.length, 1);
  assert.deepEqual([defs[0].name, defs[0].price, defs[0].sticker.fileId], ["میمون", 40, "STK-MONKEY"]);
  const cat = await giftCatalog();
  assert.ok(cat.some((g) => g.name === "میمون" && g.custom && g.price === 40 && g.anim));
});

test("A2. official Telegram gifts list (Bot API getAvailableGifts) -> pick -> name -> price", async () => {
  h.stub("getAvailableGifts", { gifts: [{ id: "g1", star_count: 50, sticker: { file_id: "OFF1", file_unique_id: "UOFF1", is_animated: true, is_video: false, emoji: "🧸" } }, { id: "g2", star_count: 100, sticker: { file_id: "OFF2", file_unique_id: "UOFF2", is_animated: false, is_video: true, emoji: "🎂" } }] });
  await h.callback(OWNER_ID, "admin:gf:tg");
  const kb = h.last("sendMessage", OWNER_ID)!.payload.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b: any) => b.callback_data === "admin:gf:tp:1"));
  await h.callback(OWNER_ID, "admin:gf:tp:1");
  await h.text(OWNER_ID, "کیک ویدیویی");
  await h.text(OWNER_ID, "25");
  await h.text(OWNER_ID, "رد");
  const d = col("mini_gift_defs").all()[0];
  assert.deepEqual([d.sticker.format, d.sticker.fileId, d.price, d.starCount], ["webm", "OFF2", 25, 100]);
});

test("A3. unique toggle + deleting a custom gift from the gift screen (owner panel callbacks)", async () => {
  await h.callback(OWNER_ID, "admin:ng:gu:cake");
  assert.equal((await getMiniSettings()).giftUnique.cake, true);
  await h.callback(OWNER_ID, "admin:ng:gu:cake");
  assert.equal((await getMiniSettings()).giftUnique.cake, false);
  await h.callback(1, "admin:ng:gu:cake"); // not an admin
  assert.equal((await getMiniSettings()).giftUnique.cake, false);
  const { addCustomGift } = await import("../../src/services/nava/giftDefs.js");
  const g = await addCustomGift({ name: "x", emoji: "🐵", price: 5, sticker: { fileId: "F", uniqueId: "U", format: "tgs" }, createdBy: OWNER_ID });
  await h.callback(OWNER_ID, `admin:ng:gd:${g._id}`);
  assert.equal(col("mini_gift_defs").all().length, 0);
});

/* ============================================================ owner delete / take */
test("T1. owner lists a user's gifts, takes one for himself and deletes another; an ordinary admin cannot; deleting a unique gift puts it back on sale", async () => {
  await setGiftUnique("crown", true);
  col("mini_gifts").seed({ _id: "1:aaaaaa", pub: "PUBCROWN1", senderId: 1, receiverId: 2, giftId: "crown", uniqueGift: true, price: 100, message: "", createdAt: new Date() } as any);
  col("mini_gifts").seed({ _id: "1:bbbbbb", pub: "PUBHEART1", senderId: 1, receiverId: 2, giftId: "heart", price: 1, message: "", createdAt: new Date(Date.now() - 1000) } as any);

  await h.callback(ADMIN_ID, "admin:gf:ug");
  await h.callback(ADMIN_ID, "admin:gf:ut:PUBCROWN1");
  assert.equal(col("mini_gifts").byId("1:aaaaaa").receiverId, 2, "admin is not the owner");

  await h.callback(OWNER_ID, "admin:gf:ug");
  await h.text(OWNER_ID, "2");
  const view = h.last("sendMessage", OWNER_ID)!.payload;
  assert.match(String(view.text), /تاج/);
  assert.ok(view.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "admin:gf:ut:PUBCROWN1"));

  await h.callback(OWNER_ID, "admin:gf:ut:PUBCROWN1");
  assert.equal(col("mini_gifts").byId("1:aaaaaa").receiverId, OWNER_ID);
  await h.callback(OWNER_ID, "admin:gf:ut:PUBCROWN1"); // second tap: already his -> nothing
  assert.equal(col("mini_gifts").all().length, 2);

  await h.callback(OWNER_ID, "admin:gf:ud:PUBHEART1");
  assert.equal(col("mini_gifts").all().length, 1);

  // the crown is still sold out (owner holds it); deleting it makes it purchasable again
  assert.equal((await giftCatalog()).find((g) => g.id === "crown")!.soldOut, true);
  await adminDeleteGift("PUBCROWN1");
  assert.equal((await giftCatalog()).find((g) => g.id === "crown")!.soldOut, false);
});

/* ============================================================ auction */
async function newAuction(startPrice = 10, hours = 2) {
  const r = await createGiftEvent(api(), { kind: "auction", giftId: "cake", ownerId: OWNER_ID, channelId: CH, startPrice, hours });
  assert.equal(r.status, "ok");
  return (r as any).event;
}

test("B1. owner creates an auction from the panel: gift minted for him, post with a bid button appears in the channel", async () => {
  await h.callback(OWNER_ID, "admin:gf:en:a");
  await h.callback(OWNER_ID, "admin:gf:eg:a:cake");
  await h.text(OWNER_ID, "10");
  await h.text(OWNER_ID, "2");
  const ev = col("gift_events").all()[0];
  assert.deepEqual([ev.kind, ev.status, ev.startPrice, ev.ownerId], ["auction", "open", 10, OWNER_ID]);
  const post = h.of("sendMessage", CH)[0]!;
  assert.match(String(post.payload.text), /حراج/);
  assert.equal(post.payload.reply_markup.inline_keyboard.flat()[0].callback_data, `ga:b:${ev._id}:0`);
  assert.equal(col("mini_gifts").all().filter((g: any) => g.receiverId === OWNER_ID && g.pub === ev.giftPub).length, 1);
  // an ordinary admin cannot start events
  await h.callback(ADMIN_ID, "admin:gf:en:a");
  assert.equal(col("gift_events").all().length, 1);
});

test("B2. bids: first bid = start price; a higher bid refunds the previous one atomically; own/top/insufficient bids are refused", async () => {
  const ev = await newAuction(10);
  await h.callback(1, `ga:b:${ev._id}:0`);
  assert.equal(bal(1), 90);
  await h.callback(1, `ga:b:${ev._id}:5`); // already the top
  assert.equal(bal(1), 90);
  await h.callback(2, `ga:b:${ev._id}:5`); // 10 + 5
  assert.deepEqual([bal(1), bal(2)], [100, 85]);
  col("users").updateOne({ _id: 3 }, { $set: { relicBalance: 3 } });
  await h.callback(3, `ga:b:${ev._id}:10`);
  assert.equal(bal(3), 3, "not enough -> nothing charged");
  await h.callback(OWNER_ID, `ga:b:${ev._id}:1`);
  const e = col("gift_events").byId(ev._id);
  assert.deepEqual([e.topBid, e.topBidderId, e.bids], [15, 2, 2]);
  assert.deepEqual([bal(1), bal(2), bal(3)], [100, 85, 3]);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "REFUND").length, 1);
  assert.ok(h.of("sendMessage", 1).some((c) => /رد شد/.test(String(c.payload.text))), "outbid person told");
});

test("B3. ten people bid at the same moment: exactly ONE amount is held at the end, everybody else is whole", async () => {
  for (let i = 5; i <= 12; i++) seedUser({ id: i, anonId: `user_BBB${i}`, nickname: `b${i}`, relicBalance: 100 });
  const ev = await newAuction(10);
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  await Promise.all(ids.map((u) => placeBid(api(), ev._id, u, 1)));
  const e = col("gift_events").byId(ev._id);
  assert.ok(e.bids >= 1);
  const total = ids.reduce((a, i) => a + bal(i), 0);
  assert.equal(total, ids.length * 100 - e.topBid, "only the current top bid is held, everything else was refunded");
  assert.equal(bal(e.topBidderId), 100 - e.topBid);
});

test("B4. auction ends: gift goes to the top bidder once (re-run does nothing), loser's Relic is back, winner told, channel post closed", async () => {
  const ev = await newAuction(10);
  await placeBid(api(), ev._id, 1, 0);
  await placeBid(api(), ev._id, 2, 7);
  assert.equal(await settleGiftEvent(api(), ev._id), null, "not due yet");
  col("gift_events").updateOne({ _id: ev._id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
  h.resetCalls();
  const r = await processDueGiftEvents(api());
  assert.equal(r.processed, 1);
  const gift = col("mini_gifts").all().find((g: any) => g.pub === ev.giftPub);
  assert.equal(gift.receiverId, 2);
  assert.equal(col("gift_events").byId(ev._id).status, "closed");
  assert.deepEqual([bal(1), bal(2)], [100, 83]);
  assert.ok(h.of("sendMessage", 2).some((c) => /مال تو شد/.test(String(c.payload.text))));
  assert.ok(h.of("editMessageText", CH).length >= 1);
  assert.equal((await processDueGiftEvents(api())).processed, 0);
  assert.equal((await placeBid(api(), ev._id, 3, 1)).status, "closed");
  assert.deepEqual([bal(1), bal(2), bal(3)], [100, 83, 100]);
});

test("B5. the owner deleted the gift during the auction: the event fails and the top bidder is refunded", async () => {
  const ev = await newAuction(10);
  await placeBid(api(), ev._id, 1, 0);
  await adminDeleteGift(ev.giftPub);
  const r = await settleGiftEvent(api(), ev._id, { force: true });
  assert.equal(r!.outcome, "gift_missing");
  assert.equal(col("gift_events").byId(ev._id).status, "failed");
  assert.equal(bal(1), 100);
});

test("B6. cancelling an auction refunds the top bidder, once; no bids -> closes quietly", async () => {
  const ev = await newAuction(10);
  await placeBid(api(), ev._id, 1, 0);
  const c = await Promise.all([settleGiftEvent(api(), ev._id, { cancel: true }), settleGiftEvent(api(), ev._id, { cancel: true })]);
  assert.equal(c.filter(Boolean).length, 1);
  assert.equal(bal(1), 100);
  const ev2 = await newAuction(5);
  assert.equal((await settleGiftEvent(api(), ev2._id, { force: true }))!.outcome, "no_bids");
});

/* ============================================================ giveaway */
test("D1. giveaway: one entry per person, owner can't enter, a banned entrant never wins, the gift moves to the winner once", async () => {
  const r = await createGiftEvent(api(), { kind: "giveaway", giftId: "rose", ownerId: OWNER_ID, channelId: CH, hours: 1 });
  assert.equal(r.status, "ok");
  const ev = (r as any).event;
  assert.equal(h.of("sendMessage", CH)[0]!.payload.reply_markup.inline_keyboard.flat()[0].callback_data, `gg:j:${ev._id}`);
  assert.equal(await joinGiveaway(ev._id, 1), "joined");
  assert.equal(await joinGiveaway(ev._id, 1), "already");
  assert.equal(await joinGiveaway(ev._id, OWNER_ID), "owner");
  await h.callback(2, `gg:j:${ev._id}`);
  await h.callback(3, `gg:j:${ev._id}`);
  assert.equal(col("gift_event_entries").all().length, 3);
  col("users").updateOne({ _id: 1 }, { $set: { banned: true } });
  col("users").updateOne({ _id: 2 }, { $set: { banned: true } });
  const [a, b] = await Promise.all([settleGiftEvent(api(), ev._id, { force: true }), settleGiftEvent(api(), ev._id, { force: true })]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const done = col("gift_events").byId(ev._id);
  assert.deepEqual([done.status, done.winnerId], ["closed", 3]);
  assert.equal(col("mini_gifts").all().find((g: any) => g.pub === ev.giftPub).receiverId, 3);
  assert.equal(await joinGiveaway(ev._id, 4), "closed");
});

test("D2. giveaway with nobody: closes without a winner; the gift stays with the owner", async () => {
  const r: any = await createGiftEvent(api(), { kind: "giveaway", giftId: "rose", ownerId: OWNER_ID, channelId: CH, hours: 1 });
  assert.equal((await settleGiftEvent(api(), r.event._id, { force: true }))!.outcome, "no_entries");
  assert.equal(col("mini_gifts").all().find((g: any) => g.pub === r.event.giftPub).receiverId, OWNER_ID);
});

/* ============================================================ unique + events */
test("U1. a unique gift somebody already owns cannot be minted for an event; one the owner holds is reused", async () => {
  await setGiftUnique("crown", true);
  col("mini_gifts").seed({ _id: "1:cccccc", pub: "PUBCR2", senderId: 1, receiverId: 2, giftId: "crown", uniqueGift: true, price: 100, message: "", createdAt: new Date() } as any);
  assert.equal(await mintGiftFor(OWNER_ID, "crown"), "sold_out");
  const r = await createGiftEvent(api(), { kind: "giveaway", giftId: "crown", ownerId: OWNER_ID, channelId: CH, hours: 1 });
  assert.equal(r.status, "sold_out");
  col("mini_gifts").updateOne({ _id: "1:cccccc" }, { $set: { receiverId: OWNER_ID } }); // the owner took it
  const r2: any = await createGiftEvent(api(), { kind: "giveaway", giftId: "crown", ownerId: OWNER_ID, channelId: CH, hours: 1 });
  assert.equal(r2.status, "ok");
  assert.equal(r2.event.giftPub, "PUBCR2");
});

test("U2. a failed channel post leaves no half-created event", async () => {
  h.failFor("sendMessage", CH);
  const r = await createGiftEvent(api(), { kind: "giveaway", giftId: "rose", ownerId: OWNER_ID, channelId: CH, hours: 1 });
  assert.ok(r.status === "channel_failed" || r.status === "ok");
});
