import type { Api } from "grammy";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { chargeRelicInSession, creditLedgerInSession } from "../../db/models/relic.js";
import { escapeHtml } from "../../utils/html.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { C, col, newId } from "./common.js";
import { giftCatalog } from "./gifts.js";
import { mintGiftFor } from "./giftAdmin.js";
import { getCustomGift } from "./giftDefs.js";

/**
 * Owner-run gift AUCTIONS and GIVEAWAYS posted to the channel.
 *  - Auction: bids are held (escrow) from the bidder's Relic in one transaction together with the refund of the
 *    outbid person and the update of the top bid; at the end the gift moves to the top bidder, in one transaction
 *    with closing the event. Relic of the winner is burned (like every gift purchase).
 *  - Giveaway: people tap «شرکت»; at the end one entrant is picked at random and the gift moves to them.
 * Every state change is guarded by `{status:"open"}` so settling / cancelling twice does nothing.
 */

export const EVENTS = "gift_events";
export const ENTRIES = "gift_event_entries";
export const BID_PREFIX = "ga:b:"; // ga:b:<eventId>:<delta>
export const JOIN_PREFIX = "gg:j:"; // gg:j:<eventId>

export type EventKind = "auction" | "giveaway";
export interface GiftEventDoc {
  _id: string;
  kind: EventKind;
  status: "open" | "closed" | "cancelled" | "failed";
  giftPub: string;
  giftId: string;
  ownerId: number;
  channelId: number;
  messageId?: number;
  startPrice: number;
  topBid: number;
  topBidderId: number | null;
  bids: number;
  endsAt: Date;
  createdAt: Date;
  winnerId?: number | null;
  settledAt?: Date;
}

export const MAX_EVENT_HOURS = 24 * 14;

export async function ensureGiftEventIndexes(db: { collection: (n: string) => any }): Promise<void> {
  await db.collection(EVENTS).createIndexes([{ key: { status: 1, endsAt: 1 }, name: "status_ends" }, { key: { giftPub: 1 }, name: "gift" }]);
  await db.collection(ENTRIES).createIndexes([{ key: { eventId: 1, userId: 1 }, name: "event_user_once", unique: true }]);
}

async function cardOf(giftId: string) {
  return (await giftCatalog(true)).find((c) => c.id === giftId);
}

/* ------------------------------------------------------------- channel post */

async function eventText(ev: GiftEventDoc): Promise<string> {
  const card = await cardOf(ev.giftId);
  const gift = `${card?.emoji ?? "🎁"} <b>${escapeHtml(card?.name ?? "هدیه")}</b>${card?.unique ? "  ✨ نسخه‌ی یکتا" : ""}`;
  const ends = ev.endsAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });
  if (ev.kind === "auction") {
    if (ev.status === "open") {
      const top = ev.topBid ? `بالاترین پیشنهاد: <b>${ev.topBid}</b> رلیک` : `قیمت شروع: <b>${ev.startPrice}</b> رلیک`;
      return `🔨 <b>حراج هدیه</b>\n\n${gift}\n\n${top}\nتعداد پیشنهادها: ${ev.bids}\nپایان: ${escapeHtml(ends)}\n\n<blockquote>رلیک پیشنهادت از همون لحظه نگه داشته میشه و اگه کسی بالاتر بزنه خودکار برمی‌گرده.</blockquote>`;
    }
    if (ev.status === "closed") return ev.winnerId ? `🔨 <b>حراج تموم شد</b>\n\n${gift}\n\n🏆 فروخته شد به ${ev.topBid} رلیک.` : `🔨 <b>حراج تموم شد</b>\n\n${gift}\n\nپیشنهادی ثبت نشد.`;
    return `🔨 <b>حراج بسته شد</b>\n\n${gift}`;
  }
  if (ev.status === "open") return `🎉 <b>قرعه‌کشی هدیه</b>\n\n${gift}\n\nپایان: ${escapeHtml(ends)}\nبرای شرکت دکمه‌ی پایین رو بزن؛ یه نفر به‌صورت تصادفی برنده میشه.`;
  if (ev.status === "closed") return ev.winnerId ? `🎉 <b>قرعه‌کشی تموم شد</b>\n\n${gift}\n\n🏆 برنده انتخاب شد و هدیه به پروفایلش رفت.` : `🎉 <b>قرعه‌کشی تموم شد</b>\n\n${gift}\n\nکسی شرکت نکرد.`;
  return `🎉 <b>قرعه‌کشی بسته شد</b>\n\n${gift}`;
}

function eventKeyboard(ev: GiftEventDoc) {
  if (ev.status !== "open") return { inline_keyboard: [] };
  if (ev.kind === "giveaway") return inlineKeyboard([[glassButton("🎉 شرکت در قرعه‌کشی", `${JOIN_PREFIX}${ev._id}`, "success")]]);
  if (!ev.topBid) return inlineKeyboard([[glassButton(`💰 پیشنهاد ${ev.startPrice} رلیک`, `${BID_PREFIX}${ev._id}:0`, "success")]]);
  return inlineKeyboard([[1, 5, 10].map((d) => glassButton(`${ev.topBid + d} رلیک`, `${BID_PREFIX}${ev._id}:${d}`, "primary"))]);
}

async function refreshPost(api: Pick<Api, "editMessageText">, ev: GiftEventDoc): Promise<void> {
  if (!ev.messageId) return;
  try {
    await api.editMessageText(ev.channelId, ev.messageId, await eventText(ev), { parse_mode: "HTML", reply_markup: eventKeyboard(ev) });
  } catch {
    /* "message is not modified" / rate limits — the DB is the truth, the post is only a view */
  }
}

/* ------------------------------------------------------------------- create */

export type CreateResult = { status: "ok"; event: GiftEventDoc } | { status: "bad_gift" | "sold_out" | "channel_failed" | "bad_input" | "busy" };

export async function createGiftEvent(
  api: Pick<Api, "sendMessage" | "sendSticker" | "editMessageText">,
  input: { kind: EventKind; giftId: string; ownerId: number; channelId: number; startPrice?: number; hours: number },
  now = new Date()
): Promise<CreateResult> {
  if (!Number.isFinite(input.hours) || input.hours < 1 || input.hours > MAX_EVENT_HOURS) return { status: "bad_input" };
  if (input.kind === "auction" && (!Number.isInteger(input.startPrice) || (input.startPrice ?? 0) < 1 || (input.startPrice ?? 0) > 100_000)) return { status: "bad_input" };
  const card = await cardOf(input.giftId);
  if (!card) return { status: "bad_gift" };

  const gifts = await col<any>(C.gifts);
  const events = await col<GiftEventDoc>(EVENTS);
  // use a copy the owner already holds (e.g. one he took from someone) that is not already in an open event, else mint one
  let pub: string | null = null;
  const held = await gifts.find({ giftId: input.giftId, receiverId: input.ownerId }).limit(20).toArray();
  for (const g of held) {
    if (!g.pub) continue;
    if (!(await events.findOne({ giftPub: g.pub, status: "open" }, { projection: { _id: 1 } }))) {
      pub = g.pub;
      break;
    }
  }
  if (!pub) {
    const minted = await mintGiftFor(input.ownerId, input.giftId);
    if (minted === "sold_out") return { status: "sold_out" };
    if (minted === "bad_gift") return { status: "bad_gift" };
    pub = minted.pub;
  }

  const ev: GiftEventDoc = {
    _id: newId(),
    kind: input.kind,
    status: "open",
    giftPub: pub,
    giftId: input.giftId,
    ownerId: input.ownerId,
    channelId: input.channelId,
    startPrice: input.startPrice ?? 0,
    topBid: 0,
    topBidderId: null,
    bids: 0,
    endsAt: new Date(now.getTime() + input.hours * 3_600_000),
    createdAt: now,
  };
  await events.insertOne(ev as any);
  try {
    if (card.custom) {
      const def = await getCustomGift(card.id);
      if (def) await api.sendSticker(input.channelId, def.sticker.fileId).catch(() => {});
    }
    const msg = await api.sendMessage(input.channelId, await eventText(ev), { parse_mode: "HTML", reply_markup: eventKeyboard(ev) });
    ev.messageId = msg.message_id;
    await events.updateOne({ _id: ev._id }, { $set: { messageId: msg.message_id } });
  } catch {
    await events.deleteOne({ _id: ev._id });
    return { status: "channel_failed" };
  }
  return { status: "ok", event: ev };
}

/* --------------------------------------------------------------------- bids */

export type BidResult =
  | { status: "ok"; amount: number; outbidUserId: number | null; event: GiftEventDoc }
  | { status: "closed" | "ended" | "owner" | "already_top" | "insufficient" | "not_found" | "busy" };

export async function placeBid(api: Pick<Api, "editMessageText" | "sendMessage">, eventId: string, bidderId: number, delta: number, now = new Date()): Promise<BidResult> {
  const events = await col<GiftEventDoc>(EVENTS);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = await runInTransaction(async (s) => {
        const ev = (await events.findOne({ _id: eventId }, { session: s })) as GiftEventDoc | null;
        if (!ev || ev.kind !== "auction") throw new TxAbort("not_found");
        if (ev.status !== "open") throw new TxAbort("closed");
        if (ev.endsAt.getTime() <= now.getTime()) throw new TxAbort("ended");
        if (bidderId === ev.ownerId) throw new TxAbort("owner");
        if (bidderId === ev.topBidderId) throw new TxAbort("already_top");
        const amount = ev.topBid === 0 ? ev.startPrice : ev.topBid + Math.max(1, Math.min(1000, Math.floor(delta)));
        if (!(await chargeRelicInSession(bidderId, amount, `abid:${ev._id}:${ev.bids + 1}`, "GIFT_SENT", `auction:${ev._id}`, s))) throw new TxAbort("insufficient");
        if (ev.topBidderId !== null) await creditLedgerInSession(`arefund:${ev._id}:${ev.bids}`, ev.topBidderId, ev.topBid, "REFUND", s, { reference: `auction:${ev._id}` });
        const upd = await events.findOneAndUpdate({ _id: eventId, status: "open", bids: ev.bids } as any, { $set: { topBid: amount, topBidderId: bidderId }, $inc: { bids: 1 } }, { session: s, returnDocument: "after" });
        if (!upd) throw new TxAbort("retry");
        return { amount, outbid: ev.topBidderId, event: upd as unknown as GiftEventDoc };
      });
      void refreshPost(api, out.event);
      if (out.outbid !== null) {
        const card = await cardOf(out.event.giftId);
        await api.sendMessage(out.outbid, `📉 پیشنهادت برای ${card?.emoji ?? "🎁"} ${escapeHtml(card?.name ?? "هدیه")} رد شد و رلیکت برگشت داده شد؛ می‌تونی دوباره بالاتر بزنی.`, { parse_mode: "HTML" }).catch(() => {});
      }
      return { status: "ok", amount: out.amount, outbidUserId: out.outbid, event: out.event };
    } catch (err: any) {
      if (err instanceof TxAbort) {
        if (err.outcome === "retry") continue;
        return { status: err.outcome as any };
      }
      if (err?.code === 11000) continue; // two bids raced for the same slot: re-read and try again
      throw err;
    }
  }
  return { status: "busy" };
}

/* ---------------------------------------------------------------- giveaway */

export async function joinGiveaway(eventId: string, userId: number, now = new Date()): Promise<"joined" | "already" | "closed" | "owner" | "not_found"> {
  const ev = (await (await col<GiftEventDoc>(EVENTS)).findOne({ _id: eventId })) as GiftEventDoc | null;
  if (!ev || ev.kind !== "giveaway") return "not_found";
  if (ev.status !== "open" || ev.endsAt.getTime() <= now.getTime()) return "closed";
  if (userId === ev.ownerId) return "owner";
  try {
    await (await col<any>(ENTRIES)).insertOne({ _id: `${eventId}:${userId}`, eventId, userId, at: now });
    return "joined";
  } catch (err: any) {
    if (err?.code === 11000) return "already";
    throw err;
  }
}

export async function countEntries(eventId: string): Promise<number> {
  return (await col<any>(ENTRIES)).countDocuments({ eventId });
}

/* ------------------------------------------------------------------- settle */

export type SettleResult = { ev: GiftEventDoc; outcome: "sold" | "won" | "no_bids" | "no_entries" | "gift_missing" | "cancelled" };

async function moveGift(ev: GiftEventDoc, toId: number, s: any): Promise<boolean> {
  const now = new Date();
  const moved = await (await col<any>(C.gifts)).findOneAndUpdate(
    { pub: ev.giftPub, receiverId: ev.ownerId },
    { $set: { receiverId: toId, senderId: ev.ownerId, anonymous: false, message: "", createdAt: now, regiftedAt: now }, $inc: { regifts: 1 } },
    { session: s }
  );
  return !!moved;
}

/**
 * Ends an event (auction: gift -> top bidder; giveaway: gift -> random entrant). ONE transaction: closing the event,
 * moving the gift and (when the gift is gone) refunding the top bidder commit together or not at all.
 * Returns null when the event is not open (already settled) or not due yet (unless `force`).
 */
export async function settleGiftEvent(api: Pick<Api, "editMessageText" | "sendMessage">, eventId: string, opts: { force?: boolean; cancel?: boolean } = {}, now = new Date()): Promise<SettleResult | null> {
  const events = await col<GiftEventDoc>(EVENTS);
  const result = await runInTransaction(async (s): Promise<SettleResult | null> => {
    const ev = (await events.findOne({ _id: eventId }, { session: s })) as GiftEventDoc | null;
    if (!ev || ev.status !== "open") return null;
    if (!opts.force && !opts.cancel && ev.endsAt.getTime() > now.getTime()) return null;
    const close = async (status: GiftEventDoc["status"], winnerId: number | null): Promise<GiftEventDoc> => {
      const upd = await events.findOneAndUpdate({ _id: eventId, status: "open" } as any, { $set: { status, winnerId, settledAt: now } }, { session: s, returnDocument: "after" });
      if (!upd) throw new TxAbort("lost_race");
      return upd as unknown as GiftEventDoc;
    };
    const refundTop = async () => {
      if (ev.kind === "auction" && ev.topBidderId !== null) await creditLedgerInSession(`arefund:${ev._id}:final`, ev.topBidderId, ev.topBid, "REFUND", s, { reference: `auction:${ev._id}` });
    };
    if (opts.cancel) {
      await refundTop();
      return { ev: await close("cancelled", null), outcome: "cancelled" };
    }
    if (ev.kind === "auction") {
      if (ev.topBidderId === null) return { ev: await close("closed", null), outcome: "no_bids" };
      if (!(await moveGift(ev, ev.topBidderId, s))) {
        await refundTop();
        return { ev: await close("failed", null), outcome: "gift_missing" };
      }
      return { ev: await close("closed", ev.topBidderId), outcome: "sold" };
    }
    // giveaway
    const entries = await (await col<any>(ENTRIES)).find({ eventId }, { session: s }).limit(10_000).toArray();
    const users = await (await import("./common.js")).usersCol();
    const pool = entries.map((e: any) => e.userId as number);
    while (pool.length) {
      const i = Math.floor(Math.random() * pool.length);
      const cand = pool.splice(i, 1)[0]!;
      const u: any = await users.findOne({ _id: cand }, { session: s, projection: { banned: 1 } });
      if (!u || u.banned) continue;
      if (!(await moveGift(ev, cand, s))) return { ev: await close("failed", null), outcome: "gift_missing" };
      return { ev: await close("closed", cand), outcome: "won" };
    }
    return { ev: await close("closed", null), outcome: "no_entries" };
  }).catch((err) => {
    if (err instanceof TxAbort) return null;
    if (err?.code === 11000) return null; // a parallel settle already wrote this refund: it owns the job
    throw err;
  });
  if (!result) return null;

  void refreshPost(api, result.ev);
  const card = await cardOf(result.ev.giftId);
  const label = `${card?.emoji ?? "🎁"} ${escapeHtml(card?.name ?? "هدیه")}`;
  if ((result.outcome === "sold" || result.outcome === "won") && result.ev.winnerId) {
    await api.sendMessage(result.ev.winnerId, `🏆 تبریک! ${label} مال تو شد.\nتوی پروفایلت، بخش «هدیه‌ها» می‌تونی ببینی‌ش.`, { parse_mode: "HTML" }).catch(() => {});
  }
  const ownerNote =
    result.outcome === "sold" ? `🔨 حراج ${label} تموم شد؛ به ${result.ev.topBid} رلیک فروخته شد.`
    : result.outcome === "won" ? `🎉 قرعه‌کشی ${label} تموم شد و برنده انتخاب شد.`
    : result.outcome === "gift_missing" ? `⚠️ ${label} دیگه توی پروفایل تو نبود؛ رویداد بسته شد و (اگه حراج بود) رلیک پیشنهاد دهنده برگشت.`
    : result.outcome === "cancelled" ? `✖️ رویداد ${label} لغو شد.`
    : `⌛ رویداد ${label} بدون برنده تموم شد.`;
  await api.sendMessage(result.ev.ownerId, ownerNote, { parse_mode: "HTML" }).catch(() => {});
  return result;
}

export async function listOpenEvents(limit = 20): Promise<GiftEventDoc[]> {
  return (await (await col<GiftEventDoc>(EVENTS)).find({ status: "open" }).sort({ endsAt: 1 }).limit(limit).toArray()) as GiftEventDoc[];
}

export async function getGiftEvent(id: string): Promise<GiftEventDoc | null> {
  return (await (await col<GiftEventDoc>(EVENTS)).findOne({ _id: id })) as GiftEventDoc | null;
}

/** Settles every event that has ended. Never throws. */
export async function processDueGiftEvents(api: Pick<Api, "editMessageText" | "sendMessage">, limit = 10): Promise<{ processed: number }> {
  try {
    const due = (await (await col<GiftEventDoc>(EVENTS)).find({ status: "open", endsAt: { $lte: new Date() } }).limit(limit).toArray()) as GiftEventDoc[];
    for (const ev of due) await settleGiftEvent(api, ev._id).catch((err) => console.error("[gift-events] settle failed:", err instanceof Error ? err.name : "unknown"));
    return { processed: due.length };
  } catch (err) {
    console.error("[gift-events] pass failed:", err instanceof Error ? err.name : "unknown");
    return { processed: 0 };
  }
}

let lastRun = 0;
export async function maybeProcessDueGiftEvents(api: Pick<Api, "editMessageText" | "sendMessage">, minGapMs = 30_000): Promise<void> {
  const t = Date.now();
  if (t - lastRun < minGapMs) return;
  lastRun = t;
  await processDueGiftEvents(api);
}

export { refreshPost as refreshEventPost };
