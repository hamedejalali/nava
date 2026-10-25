import { gunzipSync } from "node:zlib";
import { InputFile } from "grammy";
import { C, col } from "./common.js";
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

/**
 * A sticker sent by its pack's file_id opens the whole sticker PACK when tapped. A gift must show just the picture, so the
 * sticker is re-uploaded ONCE as a standalone file (no pack) and that file_id is remembered on the gift. Falls back to the
 * original id if anything goes wrong — the gift still shows, only the "pack" preview comes back.
 */
export async function freeStickerFileId(api: { getFile: (id: string) => Promise<{ file_path?: string }>; sendSticker: (chat: number, s: any) => Promise<any> }, gift: { _id: string; sticker: { fileId: string; format: string; freeFileId?: string } }): Promise<string> {
  if (gift.sticker.freeFileId) return gift.sticker.freeFileId;
  const f = gift.sticker.format;
  if (f !== "tgs" && f !== "webm" && f !== "webp") return gift.sticker.fileId;
  try {
    if (env.OWNER_ID === undefined) return gift.sticker.fileId;
    const file = await api.getFile(gift.sticker.fileId);
    if (!file.file_path) return gift.sticker.fileId;
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) return gift.sticker.fileId;
    const buf = Buffer.from(await res.arrayBuffer());
    const sent = await api.sendSticker(env.OWNER_ID, new InputFile(buf, `gift.${f}`));
    const id: string | undefined = sent?.sticker?.file_id;
    if (!id) return gift.sticker.fileId;
    await (await col<any>(C.giftDefs)).updateOne({ _id: gift._id }, { $set: { "sticker.freeFileId": id } });
    return id;
  } catch {
    return gift.sticker.fileId;
  }
}
