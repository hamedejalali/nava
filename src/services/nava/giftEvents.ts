import type { Api } from "grammy";
import { randomInt } from "node:crypto";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { chargeRelicInSession, creditLedgerInSession } from "../../db/models/relic.js";
import { escapeHtml } from "../../utils/html.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { C, col, newId } from "./common.js";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import { giftCatalog } from "./gifts.js";
import { mintGiftFor } from "./giftAdmin.js";
import { getCustomGift } from "./giftDefs.js";

/**
 * Owner-run gift AUCTIONS and GIVEAWAYS posted to the (separate) events channel. ONE channel post per event is
 *  edited in place: every bid / entry appears as a quote in that same post.
 *  - Auction: bids are held (escrow) from the bidder's XP in one transaction together with the refund of the
 *    outbid person and the update of the top bid; at the end — in ONE transaction — the gift moves to the top bidder,
 *    the held XP is paid to the OWNER and the event closes. The buyer is charged exactly once (at his winning bid).
 *  - Giveaway: people tap «شرکت»; the post lists the participants as a quote; at the end one or more winners
 *    are picked at random, the gift moves to them and the post names them.
 * Every state change is guarded by `{status:"open"}` so settling / cancelling twice does nothing.
 */

export const EVENTS = "gift_events";
export const ENTRIES = "gift_event_entries";
export const BIDS = "gift_event_bids";
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
  /** giveaway: how many winners are drawn (1 = default) and, once closed, who they are */
  winners?: number;
  winnerIds?: number[];
  winnerNames?: string[];
  /** display name of the top bidder / buyer (nickname at the time of the bid) */
  topBidderName?: string;
  settledAt?: Date;
  /** the channel post could not be edited the last time: a sweeper re-renders it */
  postStale?: boolean;
  lastEditAt?: number;
}

export const MAX_EVENT_HOURS = 24 * 14;
export const MAX_WINNERS = 10;
const POST_LIMIT = 3900; // Telegram caps a message at 4096 characters

export async function ensureGiftEventIndexes(db: { collection: (n: string) => any }): Promise<void> {
  await db.collection(EVENTS).createIndexes([{ key: { status: 1, endsAt: 1 }, name: "status_ends" }, { key: { giftPub: 1 }, name: "gift" }]);
  await db.collection(ENTRIES).createIndexes([{ key: { eventId: 1, userId: 1 }, name: "event_user_once", unique: true }, { key: { eventId: 1, at: 1 }, name: "event_at" }]);
  await db.collection(BIDS).createIndexes([{ key: { eventId: 1, n: -1 }, name: "event_n" }]);
}

async function cardOf(giftId: string) {
  return (await giftCatalog(true)).find((c) => c.id === giftId);
}

/* ------------------------------------------------------------- channel post */

const nameOf = (u: any) => String(u?.nickname ?? u?.anonId ?? "کاربر");

/** quote block; long lists collapse (Telegram's expandable quote) */
function quote(lines: string[], budget: number): string {
  if (!lines.length) return "";
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (used + lines[i]!.length + 1 > budget) {
      out.push(`… و ${lines.length - i} مورد دیگه`);
      break;
    }
    out.push(lines[i]!);
    used += lines[i]!.length + 1;
  }
  return `<blockquote${lines.length > 4 ? " expandable" : ""}>${out.join("\n")}</blockquote>`;
}

async function eventText(ev: GiftEventDoc): Promise<string> {
  const card = await cardOf(ev.giftId);
  const gift = `${card?.emoji ?? "🎁"} <b>${escapeHtml(card?.name ?? "هدیه")}</b>${card?.unique ? "  ✨ نسخه‌ی یکتا" : ""}`;
  const ends = ev.endsAt.toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });
  if (ev.kind === "auction") {
    const bids = (await (await col<any>(BIDS)).find({ eventId: ev._id }).sort({ n: -1 }).limit(12).toArray()).reverse();
    const lines = bids.map((b: any) => `${escapeHtml(String(b.name))} قیمت ${b.amount} XP رو پیشنهاد داد`);
    if (ev.status === "open") {
      const top = ev.topBid ? `بالاترین پیشنهاد: <b>${ev.topBid}</b> XP` : `قیمت شروع: <b>${ev.startPrice}</b> XP`;
      const head = `🔨 <b>حراج هدیه</b>\n\n${gift}\n\n${top}\nتعداد پیشنهادها: ${ev.bids}\nپایان: ${escapeHtml(ends)}\n\n`;
      const foot = `\n<blockquote>XP پیشنهادت از همون لحظه نگه داشته میشه و اگه کسی بالاتر بزنه خودکار برمی‌گرده.</blockquote>`;
      return head + quote(lines, POST_LIMIT - head.length - foot.length - 50) + foot;
    }
    if (ev.status === "closed") {
      const head = ev.winnerId
        ? `🔨 <b>حراج تموم شد</b>\n\n${gift}\n\n🏆 فروخته شد به <b>${escapeHtml(ev.topBidderName ?? "")}</b> با ${ev.topBid} XP\n\n`
        : `🔨 <b>حراج تموم شد</b>\n\n${gift}\n\nپیشنهادی ثبت نشد.`;
      return head + quote(lines, POST_LIMIT - head.length - 50);
    }
    return `🔨 <b>حراج بسته شد</b>\n\n${gift}`;
  }
  const entries = (await (await col<any>(ENTRIES)).find({ eventId: ev._id }).sort({ at: 1 }).limit(400).toArray()) as any[];
  const total = await countEntries(ev._id);
  const names = entries.map((e, i) => `${i + 1}. ${escapeHtml(String(e.name ?? "کاربر"))}`);
  const more = total > entries.length ? [`… و ${total - entries.length} نفر دیگه`] : [];
  const wantWinners = ev.winners && ev.winners > 1 ? `\nتعداد برنده: ${ev.winners}` : "";
  if (ev.status === "open") {
    const head = `🎉 <b>قرعه‌کشی هدیه</b>\n\n${gift}${wantWinners}\n\nشرکت‌کننده‌ها: ${total} نفر\nپایان: ${escapeHtml(ends)}\nبرای شرکت دکمه‌ی پایین رو بزن.\n\n`;
    return head + (names.length ? quote([...names, ...more], POST_LIMIT - head.length - 50) : "<blockquote>هنوز کسی شرکت نکرده.</blockquote>");
  }
  if (ev.status === "closed") {
    const w = ev.winnerNames ?? [];
    const head = w.length
      ? `🎉 <b>قرعه‌کشی تموم شد</b>\n\n${gift}\n\n🏆 ${w.length > 1 ? "برنده‌ها" : "برنده"}: <b>${w.map((x) => escapeHtml(x)).join("، ")}</b>\n\nشرکت‌کننده‌ها (${total} نفر):\n`
      : `🎉 <b>قرعه‌کشی تموم شد</b>\n\n${gift}\n\nکسی شرکت نکرد.`;
    return head + (w.length ? quote([...names, ...more], POST_LIMIT - head.length - 50) : "");
  }
  return `🎉 <b>قرعه‌کشی بسته شد</b>\n\n${gift}`;
}

function eventKeyboard(ev: GiftEventDoc) {
  if (ev.status !== "open") return { inline_keyboard: [] };
  if (ev.kind === "giveaway") return inlineKeyboard([[glassButton("🎉 شرکت در قرعه‌کشی", `${JOIN_PREFIX}${ev._id}`, "success")]]);
  if (!ev.topBid) return inlineKeyboard([[glassButton(`💰 پیشنهاد ${ev.startPrice} XP`, `${BID_PREFIX}${ev._id}:0`, "success")]]);
  return inlineKeyboard([[1, 5, 10].map((d) => glassButton(`${ev.topBid + d} XP`, `${BID_PREFIX}${ev._id}:${d}`, "primary"))]);
}

type PostApi = Pick<Api, "editMessageText">;

/** Re-renders the channel post from the database (the DB is the truth, the post is only a view). Awaited by every
 *  caller — a serverless function may be frozen right after the response, so nothing is left "fire and forget". */
async function refreshPost(api: PostApi, ev: GiftEventDoc): Promise<boolean> {
  if (!ev.messageId) return true;
  const events = await col<GiftEventDoc>(EVENTS);
  const text = await eventText(ev);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api.editMessageText(ev.channelId, ev.messageId, text, { parse_mode: "HTML", reply_markup: eventKeyboard(ev) });
      await events.updateOne({ _id: ev._id }, { $set: { postStale: false } }).catch(() => {});
      return true;
    } catch (err: any) {
      if (/message is not modified/i.test(String(err?.description ?? err?.message ?? ""))) {
        await events.updateOne({ _id: ev._id }, { $set: { postStale: false } }).catch(() => {});
        return true;
      }
      const wait = Number(err?.parameters?.retry_after);
      if (attempt === 0 && wait > 0 && wait <= 2) {
        await new Promise((r) => setTimeout(r, wait * 1000 + 50));
        continue;
      }
      break;
    }
  }
  await events.updateOne({ _id: ev._id }, { $set: { postStale: true } }).catch(() => {});
  return false;
}

/** Edit the post with the LATEST state, but at most about once a second per event (Telegram's edit limits);
 *  a skipped edit leaves `postStale` set, and the next bid / entry / sweeper pass renders everything. */
async function touchPost(api: PostApi, eventId: string, now = Date.now()): Promise<void> {
  const events = await col<GiftEventDoc>(EVENTS);
  const claimed = await events.findOneAndUpdate({ _id: eventId, $or: [{ lastEditAt: { $exists: false } }, { lastEditAt: { $lt: now - 1000 } }] } as any, { $set: { lastEditAt: now } }, { returnDocument: "after" });
  if (!claimed) {
    await events.updateOne({ _id: eventId }, { $set: { postStale: true } }).catch(() => {});
    return;
  }
  await refreshPost(api, claimed as unknown as GiftEventDoc);
}

/* ------------------------------------------------------------------- create */

export type CreateResult = { status: "ok"; event: GiftEventDoc } | { status: "bad_gift" | "sold_out" | "channel_failed" | "bad_input" | "busy" };

export async function createGiftEvent(
  api: Pick<Api, "sendMessage" | "sendSticker" | "editMessageText">,
  input: { kind: EventKind; giftId: string; ownerId: number; channelId: number; startPrice?: number; hours: number; winners?: number },
  now = new Date()
): Promise<CreateResult> {
  if (!Number.isFinite(input.hours) || input.hours < 1 || input.hours > MAX_EVENT_HOURS) return { status: "bad_input" };
  if (input.kind === "auction" && (!Number.isInteger(input.startPrice) || (input.startPrice ?? 0) < 1 || (input.startPrice ?? 0) > 100_000)) return { status: "bad_input" };
  const winners = input.kind === "giveaway" ? input.winners ?? 1 : 1;
  if (!Number.isInteger(winners) || winners < 1 || winners > MAX_WINNERS) return { status: "bad_input" };
  const card = await cardOf(input.giftId);
  if (!card) return { status: "bad_gift" };
  if (winners > 1 && card.unique) return { status: "bad_input" }; // a unique gift exists once: it cannot have several winners

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
    ...(input.kind === "giveaway" ? { winners } : {}),
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
  const users = await (await import("./common.js")).usersCol();
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
        if (!(await chargeRelicInSession(bidderId, amount, `abid:${ev._id}:${ev.bids + 1}`, "AUCTION_BID", `auction:${ev._id}`, s))) throw new TxAbort("insufficient");
        if (ev.topBidderId !== null) await creditLedgerInSession(`arefund:${ev._id}:${ev.bids}`, ev.topBidderId, ev.topBid, "REFUND", s, { reference: `auction:${ev._id}` });
        const me: any = await users.findOne({ _id: bidderId }, { session: s, projection: { nickname: 1, anonId: 1 } });
        const name = nameOf(me);
        const upd = await events.findOneAndUpdate({ _id: eventId, status: "open", bids: ev.bids } as any, { $set: { topBid: amount, topBidderId: bidderId, topBidderName: name }, $inc: { bids: 1 } }, { session: s, returnDocument: "after" });
        if (!upd) throw new TxAbort("retry");
        await (await col<any>(BIDS)).insertOne({ _id: `${eventId}:${ev.bids + 1}`, eventId, n: ev.bids + 1, userId: bidderId, name, amount, at: now }, { session: s });
        return { amount, outbid: ev.topBidderId, event: upd as unknown as GiftEventDoc };
      });
      await touchPost(api, eventId, now.getTime());
      if (out.outbid !== null) {
        const card = await cardOf(out.event.giftId);
        await api.sendMessage(out.outbid, `📉 پیشنهادت برای ${card?.emoji ?? "🎁"} ${escapeHtml(card?.name ?? "هدیه")} رد شد و XP‌ت برگشت داده شد؛ می‌تونی دوباره بالاتر بزنی.`, { parse_mode: "HTML" }).catch(() => {});
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

export async function joinGiveaway(eventId: string, userId: number, now = new Date(), api?: PostApi): Promise<"joined" | "already" | "closed" | "owner" | "not_found"> {
  const ev = (await (await col<GiftEventDoc>(EVENTS)).findOne({ _id: eventId })) as GiftEventDoc | null;
  if (!ev || ev.kind !== "giveaway") return "not_found";
  if (ev.status !== "open" || ev.endsAt.getTime() <= now.getTime()) return "closed";
  if (userId === ev.ownerId) return "owner";
  const me: any = await (await (await import("./common.js")).usersCol()).findOne({ _id: userId }, { projection: { nickname: 1, anonId: 1 } });
  try {
    await (await col<any>(ENTRIES)).insertOne({ _id: `${eventId}:${userId}`, eventId, userId, name: nameOf(me), at: now });
  } catch (err: any) {
    if (err?.code === 11000) return "already";
    throw err;
  }
  if (api) await touchPost(api, eventId, now.getTime());
  return "joined";
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

/** an extra winner of a multi-winner giveaway gets a fresh (non-unique) copy minted straight to him, inside the settle transaction */
async function mintTo(ev: GiftEventDoc, toId: number, s: any): Promise<void> {
  await (await col<any>(C.gifts)).insertOne(
    { _id: `own:${newId()}`, pub: newId(), senderId: ev.ownerId, receiverId: toId, giftId: ev.giftId, price: 0, message: "", anonymous: false, createdAt: new Date() },
    { session: s }
  );
}

/**
 * Ends an event (auction: gift -> top bidder AND the held XP -> the owner; giveaway: gift -> random entrant(s)).
 * ONE transaction: closing the event, moving the gift and paying the owner (or refunding the top bidder when the gift is
 * gone) commit together or not at all. Returns null when the event is not open (already settled) or not due yet.
 */
export async function settleGiftEvent(api: Pick<Api, "editMessageText" | "sendMessage">, eventId: string, opts: { force?: boolean; cancel?: boolean } = {}, now = new Date()): Promise<SettleResult | null> {
  const events = await col<GiftEventDoc>(EVENTS);
  const result = await runInTransaction(async (s): Promise<SettleResult | null> => {
    const ev = (await events.findOne({ _id: eventId }, { session: s })) as GiftEventDoc | null;
    if (!ev || ev.status !== "open") return null;
    if (!opts.force && !opts.cancel && ev.endsAt.getTime() > now.getTime()) return null;
    const close = async (status: GiftEventDoc["status"], winnerId: number | null, extra: Record<string, unknown> = {}): Promise<GiftEventDoc> => {
      const upd = await events.findOneAndUpdate({ _id: eventId, status: "open" } as any, { $set: { status, winnerId, settledAt: now, ...extra } }, { session: s, returnDocument: "after" });
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
      // the buyer's XP is already held (deducted when he made the winning bid); now it goes to the owner — same transaction
      const ownerExists = await (await (await import("./common.js")).usersCol()).findOne({ _id: ev.ownerId }, { session: s, projection: { _id: 1 } });
      if (ownerExists && ev.topBid > 0) await creditLedgerInSession(`asale:${ev._id}`, ev.ownerId, ev.topBid, "AUCTION_SALE", s, { reference: `auction:${ev._id}`, counterpartyUserId: ev.topBidderId });
      return { ev: await close("closed", ev.topBidderId), outcome: "sold" };
    }
    // giveaway
    const entries = await (await col<any>(ENTRIES)).find({ eventId }, { session: s }).limit(10_000).toArray();
    const users = await (await import("./common.js")).usersCol();
    const pool = entries.map((e: any) => ({ id: e.userId as number, name: String(e.name ?? "کاربر") }));
    const want = Math.max(1, ev.winners ?? 1);
    const picked: Array<{ id: number; name: string }> = [];
    while (pool.length && picked.length < want) {
      const i = randomInt(pool.length);
      const cand = pool.splice(i, 1)[0]!;
      const u: any = await users.findOne({ _id: cand.id }, { session: s, projection: { banned: 1, nickname: 1 } });
      if (!u || u.banned) continue;
      picked.push({ id: cand.id, name: u.nickname ? String(u.nickname) : cand.name });
    }
    if (!picked.length) return { ev: await close("closed", null), outcome: "no_entries" };
    if (!(await moveGift(ev, picked[0]!.id, s))) return { ev: await close("failed", null), outcome: "gift_missing" };
    for (const extra of picked.slice(1)) await mintTo(ev, extra.id, s);
    return { ev: await close("closed", picked[0]!.id, { winnerIds: picked.map((p) => p.id), winnerNames: picked.map((p) => p.name) }), outcome: "won" };
  }).catch((err) => {
    if (err instanceof TxAbort) return null;
    if (err?.code === 11000) return null; // a parallel settle already wrote this refund / payout: it owns the job
    throw err;
  });
  if (!result) return null;

  await refreshPost(api, result.ev);
  const card = await cardOf(result.ev.giftId);
  const label = `${card?.emoji ?? "🎁"} ${escapeHtml(card?.name ?? "هدیه")}`;
  if (result.outcome === "sold" && result.ev.winnerId) {
    await api.sendMessage(result.ev.winnerId, `🏆 تبریک! ${label} مال تو شد.\nتوی پروفایلت، بخش «هدیه‌ها» می‌تونی ببینی‌ش.`, { parse_mode: "HTML" }).catch(() => {});
  }
  if (result.outcome === "won") {
    for (const id of result.ev.winnerIds ?? (result.ev.winnerId ? [result.ev.winnerId] : [])) {
      await api.sendMessage(id, `🏆 تبریک! تو برنده‌ی قرعه‌کشی ${label} شدی.\nتوی پروفایلت، بخش «هدیه‌ها» می‌تونی ببینی‌ش.`, { parse_mode: "HTML" }).catch(() => {});
    }
  }
  const ownerNote =
    result.outcome === "sold" ? `🔨 حراج ${label} تموم شد؛ به ${escapeHtml(result.ev.topBidderName ?? "")} با ${result.ev.topBid} XP فروخته شد و ${result.ev.topBid} XP به حساب تو اضافه شد.`
    : result.outcome === "won" ? `🎉 قرعه‌کشی ${label} تموم شد. ${(result.ev.winnerNames?.length ?? 0) > 1 ? "برنده‌ها" : "برنده"}: ${(result.ev.winnerNames ?? []).map(escapeHtml).join("، ")}`
    : result.outcome === "gift_missing" ? `⚠️ ${label} دیگه توی پروفایل تو نبود؛ رویداد بسته شد و (اگه حراج بود) XP پیشنهاد دهنده برگشت.`
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

/** Re-renders posts whose last edit failed / was skipped (Telegram limits). Never throws. */
export async function refreshStaleEventPosts(api: PostApi, limit = 10): Promise<number> {
  try {
    const stale = (await (await col<GiftEventDoc>(EVENTS)).find({ postStale: true }).limit(limit).toArray()) as GiftEventDoc[];
    for (const ev of stale) await refreshPost(api, ev);
    return stale.length;
  } catch {
    return 0;
  }
}

/** Settles every event that has ended. Never throws. */
export async function processDueGiftEvents(api: Pick<Api, "editMessageText" | "sendMessage">, limit = 10): Promise<{ processed: number }> {
  try {
    const due = (await (await col<GiftEventDoc>(EVENTS)).find({ status: "open", endsAt: { $lte: new Date() } }).limit(limit).toArray()) as GiftEventDoc[];
    for (const ev of due) await settleGiftEvent(api, ev._id).catch((err) => console.error("[gift-events] settle failed:", err instanceof Error ? err.name : "unknown"));
    await refreshStaleEventPosts(api);
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
