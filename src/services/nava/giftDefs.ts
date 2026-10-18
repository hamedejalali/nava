import { randomBytes } from "node:crypto";
import { C, col } from "./common.js";

/**
 * Gifts the owner added from Telegram's own gift stickers (Bot API `getAvailableGifts`, or any animated sticker
 * the owner sends to the bot). They are stored in MongoDB — nothing in the code or env — and appear next to the
 * built-in gifts with their ORIGINAL Telegram animation (TGS/Lottie or WebM video sticker).
 */
export type StickerFormat = "tgs" | "webm" | "webp" | "png" | "jpg";
/** still pictures (a cut-out PNG / static sticker / photo): the Mini App gives them a slow floating motion */
export const STILL_FORMATS: StickerFormat[] = ["webp", "png", "jpg"];

export interface CustomGiftDoc {
  _id: string; // "tg" + 6 lowercase base36 chars
  name: string; // Persian display name
  emoji: string; // fallback glyph (also used in notifications)
  price: number; // Relic
  sticker: { fileId: string; uniqueId: string; format: StickerFormat };
  enabled: boolean;
  /** Telegram's own Star price when it was imported from getAvailableGifts (informational) */
  starCount?: number;
  c1: string;
  c2: string;
  pattern: string;
  createdAt: Date;
  createdBy: number;
}

const PALETTES: Array<[string, string]> = [
  ["#7f8cff", "#4a2fbd"], ["#ff9a6b", "#b4421a"], ["#5be0b4", "#0b7a64"], ["#ffb3d1", "#b03a78"], ["#6bd0ff", "#1a58b8"], ["#ffd86b", "#b27500"],
];

export const CUSTOM_ID_RE = /^tg[a-z0-9]{6}$/;
export const MAX_GIFT_NAME = 24;
export const MAX_GIFT_PRICE = 100_000;

export function stickerFormatOf(s: { is_animated?: boolean; is_video?: boolean }): StickerFormat {
  return s.is_animated ? "tgs" : s.is_video ? "webm" : "webp";
}

export async function listCustomGifts(): Promise<CustomGiftDoc[]> {
  return (await col<CustomGiftDoc>(C.giftDefs)).find({}).sort({ createdAt: 1 }).toArray();
}

export async function getCustomGift(id: unknown): Promise<CustomGiftDoc | null> {
  if (typeof id !== "string" || !CUSTOM_ID_RE.test(id)) return null;
  return (await col<CustomGiftDoc>(C.giftDefs)).findOne({ _id: id });
}

export async function addCustomGift(input: {
  name: string;
  emoji: string;
  price: number;
  sticker: CustomGiftDoc["sticker"];
  starCount?: number;
  createdBy: number;
}): Promise<CustomGiftDoc> {
  const name = input.name.trim().slice(0, MAX_GIFT_NAME);
  if (!name) throw new Error("bad_name");
  if (!Number.isInteger(input.price) || input.price < 1 || input.price > MAX_GIFT_PRICE) throw new Error("bad_price");
  const c = await col<CustomGiftDoc>(C.giftDefs);
  const [c1, c2] = PALETTES[Math.floor(Math.random() * PALETTES.length)]!;
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc: CustomGiftDoc = {
      _id: "tg" + [...randomBytes(6)].map((b) => (b % 36).toString(36)).join(""),
      name,
      emoji: input.emoji || "🎁",
      price: input.price,
      sticker: input.sticker,
      enabled: true,
      ...(input.starCount ? { starCount: input.starCount } : {}),
      c1,
      c2,
      pattern: input.emoji || "✨",
      createdAt: new Date(),
      createdBy: input.createdBy,
    };
    try {
      await c.insertOne(doc);
      return doc;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error("id_collision");
}

export async function updateCustomGift(id: string, patch: Partial<Pick<CustomGiftDoc, "price" | "enabled" | "name">>): Promise<void> {
  await (await col<CustomGiftDoc>(C.giftDefs)).updateOne({ _id: id }, { $set: patch });
}

/** Removes the DEFINITION only when nobody owns an instance of it; otherwise it is just switched off
 *  (existing gifts keep rendering). Returns what happened. */
export async function removeCustomGift(id: string): Promise<"deleted" | "disabled" | "missing"> {
  const defs = await col<CustomGiftDoc>(C.giftDefs);
  if (!(await defs.findOne({ _id: id }, { projection: { _id: 1 } }))) return "missing";
  const gifts = await col<any>(C.gifts);
  if (await gifts.findOne({ giftId: id }, { projection: { _id: 1 } })) {
    await defs.updateOne({ _id: id }, { $set: { enabled: false } });
    return "disabled";
  }
  await defs.deleteOne({ _id: id });
  return "deleted";
}
