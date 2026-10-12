import type { Api } from "grammy";
import { getClient } from "../../db/connect.js";
import { chargeRelicInSession } from "../../db/models/relic.js";
import { escapeHtml } from "../../utils/html.js";
import { botApi } from "../miniapp.js";
import { C, SocialError, col, cleanText, findVisibleUser, toBriefs, usersCol, type Brief } from "./common.js";
import { GIFTS, giftById, type GiftDef } from "./giftCatalog.js";
import { getMiniSettings } from "./settings.js";

export const GIFT_PAGE = 30;
export const GIFT_MESSAGE_MAX = 100;

export interface GiftCard extends GiftDef {
  price: number;
}

export async function giftCatalog(includeDisabled = false): Promise<GiftCard[]> {
  const s = await getMiniSettings();
  return GIFTS.filter((g) => includeDisabled || !s.giftsDisabled[g.id]).map((g) => ({ ...g, price: s.giftPrices[g.id] ?? g.price }));
}

export interface ReceivedGift {
  id: string;
  giftId: string;
  message: string;
  at: number;
  from: Brief | null;
}

class Abort extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

/**
 * Sends a gift. The price (in Relic) is taken from the sender's balance and the gift record is
 * written in ONE transaction: either both happen or neither does. `clientId` makes a retried tap
 * idempotent (never charged twice). Insufficient balance -> SocialError("insufficient").
 */
export async function sendGift(
  viewer: any,
  receiverAnonId: unknown,
  giftIdRaw: unknown,
  messageRaw: unknown,
  clientIdRaw: unknown,
  deps: { api?: Pick<Api, "sendMessage"> } = {}
): Promise<{ status: "sent" | "duplicate"; balance: number; gift: ReceivedGift }> {
  const def = giftById(giftIdRaw);
  if (!def) throw new SocialError("bad_gift");
  const catalog = await giftCatalog();
  const card = catalog.find((g) => g.id === def.id);
  if (!card) throw new SocialError("bad_gift");
  if (typeof clientIdRaw !== "string" || !CLIENT_ID_RE.test(clientIdRaw)) throw new SocialError("bad_input");
  const message = messageRaw == null || messageRaw === "" ? "" : cleanText(messageRaw, GIFT_MESSAGE_MAX);
  if (receiverAnonId === viewer.anonId) throw new SocialError("self");
  const receiver = await findVisibleUser(viewer._id, receiverAnonId);
  if (!receiver) throw new SocialError("not_found");

  const giftId = `${viewer._id}:${clientIdRaw}`;
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
  try {
    await session.withTransaction(async () => {
      try {
        await gifts.insertOne(doc, { session });
      } catch (err: any) {
        if (err?.code === 11000) throw new Abort("duplicate");
        throw err;
      }
      const ok = await chargeRelicInSession(viewer._id, card.price, `gift:${giftId}`, "GIFT_SENT", receiver.anonId, session);
      if (!ok) throw new Abort("insufficient");
    });
  } catch (err) {
    if (err instanceof Abort) {
      if (err.code === "duplicate") return { status: "duplicate", balance: await balanceNow(), gift: await toView(doc) };
      throw new SocialError("insufficient");
    }
    throw err;
  } finally {
    await session.endSession();
  }

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

export async function countGifts(userId: number): Promise<number> {
  return (await col(C.gifts)).countDocuments({ receiverId: userId });
}

export async function listReceivedGifts(viewerId: number, anonId: unknown, before?: unknown): Promise<{ items: ReceivedGift[]; hasMore: boolean; next: number | null; total: number } | null> {
  const owner = await findVisibleUser(viewerId, anonId, { includeSelf: true });
  if (!owner) return null;
  const gifts = await col(C.gifts);
  const beforeDate = typeof before === "number" && Number.isFinite(before) && before > 0 ? new Date(before) : null;
  const rows = await gifts
    .find({ receiverId: owner._id, ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) })
    .sort({ createdAt: -1 })
    .limit(GIFT_PAGE + 1)
    .toArray();
  const page = rows.slice(0, GIFT_PAGE);
  const users = await usersCol();
  const givers = await users.find({ _id: { $in: [...new Set(page.map((r: any) => r.senderId as number))] } }).toArray();
  const briefs = await toBriefs(viewerId, givers);
  const by = new Map(givers.map((g: any, i: number) => [g._id as number, briefs[i]!]));
  const items = page.map((r: any) => ({ id: r._id as string, giftId: r.giftId as string, message: (r.message ?? "") as string, at: r.createdAt.getTime() as number, from: by.get(r.senderId) ?? null }));
  const hasMore = rows.length > GIFT_PAGE;
  return { items, hasMore, next: hasMore ? items[items.length - 1]!.at : null, total: await gifts.countDocuments({ receiverId: owner._id }) };
}
