import type { Api } from "grammy";
import { getClient } from "../../db/connect.js";
import { chargeRelicInSession } from "../../db/models/relic.js";
import { escapeHtml } from "../../utils/html.js";
<<<<<<< HEAD
import { botApi } from "../miniapp.js";
import { C, SocialError, col, cleanText, findVisibleUser, toBriefs, usersCol, type Brief } from "./common.js";
import { GIFTS, giftById, type GiftDef } from "./giftCatalog.js";
=======
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { botApi } from "../miniapp.js";
import { C, SocialError, col, cleanText, findVisibleUser, newId, toBriefs, usersCol, type Brief } from "./common.js";
import { GIFTS, type GiftDef } from "./giftCatalog.js";
import { getCustomGift, listCustomGifts, type StickerFormat } from "./giftDefs.js";
>>>>>>> v1.11.0-wallet
import { getMiniSettings } from "./settings.js";

export const GIFT_PAGE = 30;
export const GIFT_MESSAGE_MAX = 100;
<<<<<<< HEAD

export interface GiftCard extends GiftDef {
  price: number;
=======
/** callback data of the "message the sender" button under a gift notification */
export const GIFT_REPLY_PREFIX = "gr:";

export interface GiftCard extends GiftDef {
  price: number;
  /** only ONE copy of this gift can ever be sold */
  unique: boolean;
  /** unique gift that already has an owner — cannot be bought any more (it can still be re-gifted by its owner) */
  soldOut: boolean;
  /** Telegram animation (TGS/WebM/WebP sticker) — the HTTP layer turns it into a signed URL */
  anim: { format: StickerFormat; v: string } | null;
  custom: boolean;
  /** switched off by the owner (only present in the full list used by the admin panel and for rendering old gifts) */
  off: boolean;
>>>>>>> v1.11.0-wallet
}

export async function giftCatalog(includeDisabled = false): Promise<GiftCard[]> {
  const s = await getMiniSettings();
<<<<<<< HEAD
  return GIFTS.filter((g) => includeDisabled || !s.giftsDisabled[g.id]).map((g) => ({ ...g, price: s.giftPrices[g.id] ?? g.price }));
}

export interface ReceivedGift {
=======
  const customs = await listCustomGifts();
  const unique = (id: string) => !!s.giftUnique[id];
  const uniqueIds = [...GIFTS.map((g) => g.id), ...customs.map((g) => g._id)].filter(unique);
  const taken = new Set<string>();
  if (uniqueIds.length) {
    const rows = await (await col<any>(C.gifts)).find({ giftId: { $in: uniqueIds } }, { projection: { giftId: 1 } }).toArray();
    for (const r of rows) taken.add(r.giftId);
  }
  const cards: GiftCard[] = [];
  for (const g of GIFTS) {
    if (!includeDisabled && s.giftsDisabled[g.id]) continue;
    cards.push({ ...g, price: s.giftPrices[g.id] ?? g.price, unique: unique(g.id), soldOut: unique(g.id) && taken.has(g.id), anim: null, custom: false, off: !!s.giftsDisabled[g.id] });
  }
  for (const g of customs) {
    const off = !g.enabled || s.giftsDisabled[g._id];
    if (!includeDisabled && off) continue;
    cards.push({
      id: g._id,
      emoji: g.emoji,
      name: g.name,
      price: s.giftPrices[g._id] ?? g.price,
      c1: g.c1,
      c2: g.c2,
      pattern: g.pattern,
      unique: unique(g._id),
      soldOut: unique(g._id) && taken.has(g._id),
      anim: { format: g.sticker.format, v: g.sticker.uniqueId },
      custom: true,
      off: !!off,
    });
  }
  return cards;
}

export interface ReceivedGift {
  /** opaque public id of THIS gift (never a Telegram id) — used to re-gift it */
>>>>>>> v1.11.0-wallet
  id: string;
  giftId: string;
  message: string;
  at: number;
<<<<<<< HEAD
  from: Brief | null;
=======
  /** null when the sender chose to stay anonymous */
  from: Brief | null;
  anonymous: boolean;
>>>>>>> v1.11.0-wallet
}

class Abort extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
<<<<<<< HEAD
=======
const PUB_RE = /^[A-Za-z0-9_-]{6,24}$/;
export const UNKNOWN_SENDER = "ناشناس";

function senderLabel(viewer: any): string {
  return viewer.miniUsername ? `@${viewer.miniUsername}` : (viewer.nickname ?? "یک کاربر");
}

/** Tells the receiver about a gift. A named gift carries a button to message the sender; an anonymous one never does. */
async function notifyReceiver(
  api: Pick<Api, "sendMessage">,
  receiverId: number,
  opts: { sender: any; anonymous: boolean; emoji: string; name: string; message: string; pub: string; regift?: boolean }
): Promise<void> {
  try {
    const giver = opts.anonymous ? `یک فرد ${UNKNOWN_SENDER}` : escapeHtml(senderLabel(opts.sender));
    const note = opts.message ? `\n<blockquote>${escapeHtml(opts.message)}</blockquote>` : "";
    const verb = opts.regift ? "یه هدیه برات فرستاد (هدیه‌ی دست‌به‌دست‌شده)" : "برات یه هدیه فرستاد";
    const text = `🎁 <b>${giver}</b> ${verb}: ${opts.emoji} ${escapeHtml(opts.name)}${note}\nتوی پروفایلت، بخش «هدیه‌ها» می‌تونی ببینی‌ش.`;
    await api.sendMessage(receiverId, text, {
      parse_mode: "HTML",
      ...(opts.anonymous ? {} : { reply_markup: inlineKeyboard([[glassButton("پیام به فرستنده", `${GIFT_REPLY_PREFIX}${opts.pub}`, "primary", { fallback: "💬" })]]) }),
    });
  } catch {
    /* receiver may have blocked the bot */
  }
}
>>>>>>> v1.11.0-wallet

/**
 * Sends a gift. The price (in Relic) is taken from the sender's balance and the gift record is
 * written in ONE transaction: either both happen or neither does. `clientId` makes a retried tap
 * idempotent (never charged twice). Insufficient balance -> SocialError("insufficient").
<<<<<<< HEAD
=======
 * A UNIQUE gift can only be sold once: the second buyer gets SocialError("sold_out") — decided by a
 * partial unique index, so two simultaneous buyers can never both get it.
>>>>>>> v1.11.0-wallet
 */
export async function sendGift(
  viewer: any,
  receiverAnonId: unknown,
  giftIdRaw: unknown,
  messageRaw: unknown,
  clientIdRaw: unknown,
<<<<<<< HEAD
  deps: { api?: Pick<Api, "sendMessage"> } = {}
): Promise<{ status: "sent" | "duplicate"; balance: number; gift: ReceivedGift }> {
  const def = giftById(giftIdRaw);
  if (!def) throw new SocialError("bad_gift");
  const catalog = await giftCatalog();
  const card = catalog.find((g) => g.id === def.id);
  if (!card) throw new SocialError("bad_gift");
  if (typeof clientIdRaw !== "string" || !CLIENT_ID_RE.test(clientIdRaw)) throw new SocialError("bad_input");
  const message = messageRaw == null || messageRaw === "" ? "" : cleanText(messageRaw, GIFT_MESSAGE_MAX);
=======
  deps: { api?: Pick<Api, "sendMessage"> } = {},
  anonymousRaw?: unknown
): Promise<{ status: "sent" | "duplicate"; balance: number; gift: ReceivedGift }> {
  const catalog = await giftCatalog();
  const card = typeof giftIdRaw === "string" ? catalog.find((g) => g.id === giftIdRaw) : undefined;
  if (!card) throw new SocialError("bad_gift");
  if (typeof clientIdRaw !== "string" || !CLIENT_ID_RE.test(clientIdRaw)) throw new SocialError("bad_input");
  const message = messageRaw == null || messageRaw === "" ? "" : cleanText(messageRaw, GIFT_MESSAGE_MAX);
  const anonymous = anonymousRaw === true;
>>>>>>> v1.11.0-wallet
  if (receiverAnonId === viewer.anonId) throw new SocialError("self");
  const receiver = await findVisibleUser(viewer._id, receiverAnonId);
  if (!receiver) throw new SocialError("not_found");

  const giftId = `${viewer._id}:${clientIdRaw}`;
<<<<<<< HEAD
  const gifts = await col(C.gifts);
  const users = await usersCol();
  const already = await gifts.findOne({ _id: giftId });
  const toView = async (d: any): Promise<ReceivedGift> => {
    const [from] = await toBriefs(viewer._id, [viewer]);
    return { id: d._id, giftId: d.giftId, message: d.message ?? "", at: d.createdAt.getTime(), from: from ?? null };
  };
  const balanceNow = async () => ((await users.findOne({ _id: viewer._id }, { projection: { relicBalance: 1 } }))?.relicBalance ?? 0) as number;
  if (already) return { status: "duplicate", balance: await balanceNow(), gift: await toView(already) };

  const client = await getClient();
  const session = client.startSession();
  const doc = { _id: giftId, senderId: viewer._id, receiverId: receiver._id, giftId: def.id, price: card.price, message, createdAt: new Date() };
=======
  const gifts = await col<any>(C.gifts);
  const users = await usersCol();
  const toView = async (d: any): Promise<ReceivedGift> => {
    const [from] = await toBriefs(viewer._id, [viewer]);
    return { id: d.pub ?? d._id, giftId: d.giftId, message: d.message ?? "", at: d.createdAt.getTime(), from: d.anonymous ? null : (from ?? null), anonymous: !!d.anonymous };
  };
  const balanceNow = async () => ((await users.findOne({ _id: viewer._id }, { projection: { relicBalance: 1 } }))?.relicBalance ?? 0) as number;
  const already = await gifts.findOne({ _id: giftId });
  if (already) return { status: "duplicate", balance: await balanceNow(), gift: await toView(already) };
  if (card.soldOut) throw new SocialError("sold_out");

  const client = await getClient();
  const session = client.startSession();
  const pub = newId();
  const doc: any = {
    _id: giftId,
    pub,
    senderId: viewer._id,
    receiverId: receiver._id,
    giftId: card.id,
    price: card.price,
    message,
    anonymous,
    ...(card.unique ? { uniqueGift: true } : {}),
    createdAt: new Date(),
  };
>>>>>>> v1.11.0-wallet
  try {
    await session.withTransaction(async () => {
      try {
        await gifts.insertOne(doc, { session });
      } catch (err: any) {
<<<<<<< HEAD
        if (err?.code === 11000) throw new Abort("duplicate");
=======
        if (err?.code === 11000) throw new Abort(err?.keyPattern?.giftId || /giftId/.test(String(err?.message)) ? "sold_out" : "duplicate");
>>>>>>> v1.11.0-wallet
        throw err;
      }
      const ok = await chargeRelicInSession(viewer._id, card.price, `gift:${giftId}`, "GIFT_SENT", receiver.anonId, session);
      if (!ok) throw new Abort("insufficient");
    });
  } catch (err) {
    if (err instanceof Abort) {
      if (err.code === "duplicate") return { status: "duplicate", balance: await balanceNow(), gift: await toView(doc) };
<<<<<<< HEAD
=======
      if (err.code === "sold_out") throw new SocialError("sold_out");
>>>>>>> v1.11.0-wallet
      throw new SocialError("insufficient");
    }
    throw err;
  } finally {
    await session.endSession();
  }

<<<<<<< HEAD
  // Tell the receiver (best-effort; the gift itself is already saved).
  try {
    const giver = escapeHtml(viewer.miniUsername ? `@${viewer.miniUsername}` : (viewer.nickname ?? "یک کاربر"));
    const note = message ? `\n<blockquote>${escapeHtml(message)}</blockquote>` : "";
    await (deps.api ?? botApi()).sendMessage(receiver._id, `🎁 <b>${giver}</b> برات یه هدیه فرستاد: ${def.emoji} ${escapeHtml(def.name)}${note}\nتوی پروفایلت، بخش «هدیه‌ها» می‌تونی ببینی‌ش.`, { parse_mode: "HTML" });
  } catch {
    /* receiver may have blocked the bot */
  }
  return { status: "sent", balance: await balanceNow(), gift: await toView(doc) };
}

=======
  await notifyReceiver(deps.api ?? botApi(), receiver._id, { sender: viewer, anonymous, emoji: card.emoji, name: card.name, message, pub });
  return { status: "sent", balance: await balanceNow(), gift: await toView(doc) };
}

/**
 * The owner of a gift gives it to someone else (free). ONE atomic findOneAndUpdate on
 * `{pub, receiverId: me}`: two simultaneous taps can only move it once, and nobody can move a gift
 * they no longer own.
 */
export async function regiftGift(
  viewer: any,
  pubRaw: unknown,
  receiverAnonId: unknown,
  messageRaw: unknown,
  anonymousRaw: unknown,
  deps: { api?: Pick<Api, "sendMessage"> } = {}
): Promise<{ gift: ReceivedGift }> {
  if (typeof pubRaw !== "string" || !PUB_RE.test(pubRaw)) throw new SocialError("bad_input");
  const message = messageRaw == null || messageRaw === "" ? "" : cleanText(messageRaw, GIFT_MESSAGE_MAX);
  const anonymous = anonymousRaw === true;
  if (receiverAnonId === viewer.anonId) throw new SocialError("self");
  const receiver = await findVisibleUser(viewer._id, receiverAnonId);
  if (!receiver) throw new SocialError("not_found");
  const gifts = await col<any>(C.gifts);
  const now = new Date();
  const moved: any = await gifts.findOneAndUpdate(
    { pub: pubRaw, receiverId: viewer._id },
    { $set: { receiverId: receiver._id, senderId: viewer._id, anonymous, message, createdAt: now, regiftedAt: now }, $inc: { regifts: 1 } },
    { returnDocument: "after" }
  );
  if (!moved) throw new SocialError("not_found");
  const cards = await giftCatalog(true);
  const card = cards.find((g) => g.id === moved.giftId);
  await notifyReceiver(deps.api ?? botApi(), receiver._id, { sender: viewer, anonymous, emoji: card?.emoji ?? "🎁", name: card?.name ?? "هدیه", message, pub: moved.pub, regift: true });
  const [from] = await toBriefs(viewer._id, [viewer]);
  return { gift: { id: moved.pub, giftId: moved.giftId, message, at: now.getTime(), from: anonymous ? null : (from ?? null), anonymous } };
}

>>>>>>> v1.11.0-wallet
export async function countGifts(userId: number): Promise<number> {
  return (await col(C.gifts)).countDocuments({ receiverId: userId });
}

export async function listReceivedGifts(viewerId: number, anonId: unknown, before?: unknown): Promise<{ items: ReceivedGift[]; hasMore: boolean; next: number | null; total: number } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner) return null;
<<<<<<< HEAD
  const gifts = await col(C.gifts);
=======
  const gifts = await col<any>(C.gifts);
>>>>>>> v1.11.0-wallet
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const rows = await gifts
    .find({ receiverId: owner._id, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) })
    .sort({ createdAt: -1 })
    .limit(GIFT_PAGE + 1)
    .toArray();
  const page = rows.slice(0, GIFT_PAGE);
<<<<<<< HEAD
  const users = await usersCol();
  const givers = await users.find({ _id: { $in: [...new Set(page.map((r: any) => r.senderId as number))] } }).toArray();
  const briefs = await toBriefs(viewerId, givers);
  const by = new Map(givers.map((g: any, i: number) => [g._id as number, briefs[i]!]));
  const items = page.map((r: any) => ({ id: r._id as string, giftId: r.giftId as string, message: (r.message ?? "") as string, at: r.createdAt.getTime() as number, from: by.get(r.senderId) ?? null }));
  const hasMore = rows.length > GIFT_PAGE;
  return { items, hasMore, next: hasMore ? items[items.length - 1]!.at : null, total: await gifts.countDocuments({ receiverId: owner._id }) };
}
=======
  // gifts from before v1.17 have no public id yet: give them one (once)
  for (const r of page) {
    if (!r.pub) {
      const pub = newId();
      await gifts.updateOne({ _id: r._id, pub: { $exists: false } }, { $set: { pub } });
      r.pub = (await gifts.findOne({ _id: r._id }, { projection: { pub: 1 } }))?.pub ?? pub;
    }
  }
  const users = await usersCol();
  const givers = await users.find({ _id: { $in: [...new Set(page.filter((r: any) => !r.anonymous).map((r: any) => r.senderId as number))] } }).toArray();
  const briefs = await toBriefs(viewerId, givers);
  const by = new Map(givers.map((g: any, i: number) => [g._id as number, briefs[i]!]));
  const items: ReceivedGift[] = page.map((r: any) => ({
    id: r.pub as string,
    giftId: r.giftId as string,
    message: (r.message ?? "") as string,
    at: r.createdAt.getTime() as number,
    from: r.anonymous ? null : (by.get(r.senderId) ?? null),
    anonymous: !!r.anonymous,
  }));
  const hasMore = rows.length > GIFT_PAGE;
  return { items, hasMore, next: hasMore ? items[items.length - 1]!.at : null, total: await gifts.countDocuments({ receiverId: owner._id }) };
}

export { getCustomGift };
>>>>>>> v1.11.0-wallet
