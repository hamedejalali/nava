import { C, col, newId } from "./common.js";
import { giftCatalog } from "./gifts.js";

/** Owner-side gift tools (everything is an atomic single-document operation on `mini_gifts`). */

export interface AdminGiftRow {
  pub: string;
  giftId: string;
  name: string;
  emoji: string;
  senderId: number;
  anonymous: boolean;
  at: number;
}

async function ensurePub(g: any): Promise<string> {
  if (g.pub) return g.pub as string;
  const gifts = await col<any>(C.gifts);
  await gifts.updateOne({ _id: g._id, pub: { $exists: false } }, { $set: { pub: newId() } });
  return ((await gifts.findOne({ _id: g._id }, { projection: { pub: 1 } }))?.pub ?? "") as string;
}

/** Every gift a person currently owns (real sender included — this is the owner's view, never shown to users). */
export async function listUserGifts(userId: number, limit = 20): Promise<{ rows: AdminGiftRow[]; total: number }> {
  const gifts = await col<any>(C.gifts);
  const docs = await gifts.find({ receiverId: userId }).sort({ createdAt: -1 }).limit(limit).toArray();
  const cards = new Map((await giftCatalog(true)).map((c) => [c.id, c]));
  const rows: AdminGiftRow[] = [];
  for (const g of docs) {
    const card = cards.get(g.giftId);
    rows.push({ pub: await ensurePub(g), giftId: g.giftId, name: card?.name ?? g.giftId, emoji: card?.emoji ?? "🎁", senderId: g.senderId, anonymous: !!g.anonymous, at: g.createdAt.getTime() });
  }
  return { rows, total: await gifts.countDocuments({ receiverId: userId }) };
}

/** Deletes the gift instance. For a UNIQUE gift this puts it back on sale (nobody owns it any more). */
export async function adminDeleteGift(pub: string): Promise<{ giftId: string; ownerId: number } | null> {
  const gifts = await col<any>(C.gifts);
  const g: any = await gifts.findOneAndDelete({ pub });
  return g ? { giftId: g.giftId, ownerId: g.receiverId } : null;
}

/** The owner takes the gift for himself (atomic: moves only if `pub` still exists). */
export async function adminTakeGift(pub: string, ownerId: number): Promise<{ giftId: string; fromId: number } | null> {
  const gifts = await col<any>(C.gifts);
  const now = new Date();
  const g: any = await gifts.findOneAndUpdate(
    { pub, receiverId: { $ne: ownerId } },
    { $set: { receiverId: ownerId, senderId: ownerId, anonymous: false, message: "", createdAt: now, regiftedAt: now }, $inc: { regifts: 1 } },
    { returnDocument: "before" }
  );
  return g ? { giftId: g.giftId, fromId: g.receiverId } : null;
}

/**
 * Gives the OWNER a fresh copy of a gift type (free) — used to put a gift up for auction / giveaway.
 * A unique gift that somebody already owns cannot be minted again.
 */
export async function mintGiftFor(ownerId: number, giftId: string): Promise<{ pub: string } | "sold_out" | "bad_gift"> {
  const cards = await giftCatalog(true);
  const card = cards.find((c) => c.id === giftId);
  if (!card) return "bad_gift";
  if (card.soldOut) return "sold_out";
  const gifts = await col<any>(C.gifts);
  const pub = newId();
  try {
    await gifts.insertOne({
      _id: `own:${newId()}`,
      pub,
      senderId: ownerId,
      receiverId: ownerId,
      giftId,
      price: 0,
      message: "",
      anonymous: false,
      ...(card.unique ? { uniqueGift: true } : {}),
      createdAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return "sold_out";
    throw err;
  }
  return { pub };
}
