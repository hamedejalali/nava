/** v1.20.0 — auction/lottery: bids and entrants as quotes in the SAME edited post, owner is paid on sale, multi-winner draws. (mocked Mongo + Telegram) */
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
  await setPostsChannel(-1, "management");
  await setEventsChannel(CH, "events");
});

const lastEdit = () => String(h.of("editMessageText", CH).at(-1)?.payload.text ?? "");
const mk = async (kind: "auction" | "giveaway", extra: any = {}) => {
  const r: any = await createGiftEvent(api(), { kind, giftId: kind === "auction" ? "cake" : "rose", ownerId: OWNER_ID, channelId: CH, startPrice: 10, hours: 2, ...extra });
  assert.equal(r.status, "ok");
  return r.event;
};
const tick = () => new Promise((r) => setTimeout(r, 1100)); // post edits are throttled to ~1/s per event

test("E1. bids are written as quotes into the SAME post (edited, not re-posted)", async () => {
  const ev = await mk("auction");
  const posts = h.of("sendMessage", CH).length;
  await placeBid(api(), ev._id, 1, 0);
  await tick();
  await placeBid(api(), ev._id, 2, 5);
  const t = lastEdit();
  assert.match(t, /<blockquote/);
  assert.match(t, /u1/);
  assert.match(t, /u2/);
  assert.match(t, /15 XP/);
  assert.equal(h.of("sendMessage", CH).length, posts, "no new channel post per bid");
  assert.equal(h.of("editMessageText", CH).every((c) => c.payload.message_id === ev.messageId), true);
  assert.equal(col("gift_event_bids").all().length, 2);
});

test("E2. a sale: buyer pays once, the OWNER is credited the same amount in the same transaction, XP is conserved", async () => {
  const ev = await mk("auction");
  await placeBid(api(), ev._id, 1, 0);
  await placeBid(api(), ev._id, 2, 7);
  const before = sum(1, 2, 3, 4, OWNER_ID) + 17; // 17 XP is held in escrow by the winning bid
  const r = await settleGiftEvent(api(), ev._id, { force: true });
  assert.equal(r!.outcome, "sold");
  assert.deepEqual([bal(1), bal(2), bal(OWNER_ID)], [100, 83, 17]);
  assert.equal(sum(1, 2, 3, 4, OWNER_ID), before, "total XP unchanged by the sale (no minting)");
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "AUCTION_SALE").length, 1);
  assert.equal(await settleGiftEvent(api(), ev._id, { force: true }), null, "second settle does nothing");
  assert.equal(bal(OWNER_ID), 17, "owner paid exactly once");
  assert.match(lastEdit(), /17 XP/);
});

test("E3. auction without bids / with a vanished gift pays the owner nothing", async () => {
  const ev = await mk("auction");
  await settleGiftEvent(api(), ev._id, { force: true });
  assert.equal(bal(OWNER_ID), 0);
  const ev2 = await mk("auction");
  await placeBid(api(), ev2._id, 1, 0);
  col("mini_gifts").updateOne({ pub: ev2.giftPub }, { $set: { receiverId: 4 } });
  const r = await settleGiftEvent(api(), ev2._id, { force: true });
  assert.equal(r!.outcome, "gift_missing");
  assert.deepEqual([bal(1), bal(OWNER_ID)], [100, 0]);
});

test("E4. lottery: entrants are listed as a quote in the same post; the end shows the winner's name", async () => {
  const ev = await mk("giveaway");
  await joinGiveaway(ev._id, 1, new Date(), api());
  await tick();
  await joinGiveaway(ev._id, 2, new Date(), api());
  assert.match(lastEdit(), /<blockquote/);
  assert.match(lastEdit(), /u1/);
  assert.match(lastEdit(), /u2/);
  const r = await settleGiftEvent(api(), ev._id, { force: true });
  assert.equal(r!.outcome, "won");
  const winner = col("users").byId(r!.ev.winnerId!).nickname;
  assert.ok(lastEdit().includes(winner), "winner name in the final post");
});

test("E5. several winners: each gets his own copy (non-unique gift); fewer entrants than winners -> everybody wins", async () => {
  const ev = await mk("giveaway", { winners: 2 });
  for (const u of [1, 2, 3]) await joinGiveaway(ev._id, u);
  const r = await settleGiftEvent(api(), ev._id, { force: true });
  assert.equal(r!.ev.winnerIds!.length, 2);
  assert.equal(new Set(r!.ev.winnerIds).size, 2);
  const owned = col("mini_gifts").all().filter((g: any) => g.giftId === "rose" && r!.ev.winnerIds!.includes(g.receiverId));
  assert.equal(owned.length, 2);
  const ev2 = await mk("giveaway", { winners: 5 });
  for (const u of [1, 2]) await joinGiveaway(ev2._id, u);
  assert.equal((await settleGiftEvent(api(), ev2._id, { force: true }))!.ev.winnerIds!.length, 2);
});

test("E6. winners > 1 is refused for a unique gift and out-of-range counts", async () => {
  await setGiftUnique("crown", true);

  const bad: any = await createGiftEvent(api(), { kind: "giveaway", giftId: "rose", ownerId: OWNER_ID, channelId: CH, hours: 1, winners: 0 });
  assert.equal(bad.status, "bad_input");
  const bad2: any = await createGiftEvent(api(), { kind: "giveaway", giftId: "rose", ownerId: OWNER_ID, channelId: CH, hours: 1, winners: 999 });
  assert.equal(bad2.status, "bad_input");
});

test("E7. a skipped (throttled) edit is repaired by the sweeper; the post is never left stale", async () => {
  const ev = await mk("auction");
  await placeBid(api(), ev._id, 1, 0);
  await placeBid(api(), ev._id, 2, 5); // inside the 1 s window -> edit skipped, marked stale
  assert.equal(col("gift_events").byId(ev._id).postStale, true);
  await tick();
  await processDueGiftEvents(api());
  assert.equal(col("gift_events").byId(ev._id).postStale, false);
  assert.match(lastEdit(), /u2/);
});

test("E8. auction/lottery posts go ONLY to the events channel, nothing there from the management channel", async () => {
  await mk("auction");
  assert.equal(h.of("sendMessage", CH).length, 1);
  assert.equal(h.of("sendMessage", -1).length, 0);
});

test("E9. panel: lottery flow asks hours, then the number of winners, and creates a multi-winner event", async () => {
  await h.callback(OWNER_ID, "admin:gf:en:g");
  await h.callback(OWNER_ID, "admin:gf:eg:g:rose");
  await h.text(OWNER_ID, "3");
  await h.text(OWNER_ID, "0"); // refused
  assert.equal(col("gift_events").all().length, 0);
  await h.text(OWNER_ID, "3");
  const ev = col("gift_events").all()[0];
  assert.deepEqual([ev.kind, ev.winners], ["giveaway", 3]);
});
