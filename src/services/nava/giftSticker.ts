import { gunzipSync } from "node:zlib";
import { env } from "../../config/env.js";
import { botApi } from "../miniapp.js";
import { getCustomGift } from "./giftDefs.js";
import { signMedia, verifyMediaSig } from "./media.js";

/** Signed URL of a custom gift's Telegram animation. `v` (the sticker's unique id) is part of the URL, so it can be cached forever. */
export function giftAnimUrl(giftId: string, v: string): string {
  return `/api/miniapp?g=${encodeURIComponent(giftId)}&v=${encodeURIComponent(v)}&s=${signMedia(`g:${giftId}:${v}`)}`;
}

export function verifyGiftAnimSig(giftId: string, v: string, sig: unknown): boolean {
  return verifyMediaSig(`g:${giftId}:${v}`, sig);
}

const MAX_STICKER_BYTES = 2 * 1024 * 1024;

/**
 * Downloads the gift's sticker from Telegram. TGS (= gzipped Lottie JSON) is un-gzipped here so the
 * Mini App can feed it straight to a Lottie player; WebM stays a video; WebP stays an image.
 */
export async function loadGiftSticker(giftId: string, v: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const gift = await getCustomGift(giftId);
  if (!gift || gift.sticker.uniqueId !== v) return null;
  const file = await botApi().getFile(gift.sticker.fileId);
  if (!file.file_path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) return null;
  let buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_STICKER_BYTES) return null;
  if (gift.sticker.format === "tgs") {
    buffer = gunzipSync(buffer);
    return { buffer, contentType: "application/json" };
  }
  const f = gift.sticker.format;
  return { buffer, contentType: f === "webm" ? "video/webm" : f === "png" ? "image/png" : f === "jpg" ? "image/jpeg" : "image/webp" };
}
