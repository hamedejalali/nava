import { Binary } from "mongodb";
import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { C, SocialError, col, newId } from "./common.js";

/** Images of posts / stories / highlight covers live in MongoDB (single source of truth,
 *  independent of Telegram file lifetimes). Profile photos stay Telegram file_ids (bot pipeline). */

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export function decodeImage(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length > MAX_IMAGE_BYTES * 1.4) throw new SocialError("bad_image");
  const b64 = raw.replace(/^data:image\/(jpeg|png|webp);base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new SocialError("bad_image");
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100 || buf.length > MAX_IMAGE_BYTES) throw new SocialError("bad_image");
  if (!sniff(buf)) throw new SocialError("bad_image");
  return buf;
}

export function sniff(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

export async function storeMedia(ownerId: number, kind: "post" | "story" | "cover", buf: Buffer): Promise<string> {
  const id = newId();
  const media = await col(C.media);
  await media.insertOne({ _id: id, ownerId, kind, contentType: sniff(buf) ?? "image/jpeg", size: buf.length, data: new Binary(buf), createdAt: new Date() });
  return id;
}

function toBuffer(d: any): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (d instanceof Binary) return Buffer.from(d.buffer.subarray(0, d.position));
  if (d && d.buffer) return Buffer.from(d.buffer);
  return Buffer.from(d);
}

export async function loadMedia(id: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const media = await col(C.media);
  const doc = await media.findOne({ _id: id });
  if (!doc) return null;
  return { buffer: toBuffer(doc.data), contentType: doc.contentType || "image/jpeg" };
}

export async function deleteMedia(ids: Array<string | null | undefined>): Promise<void> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  const media = await col(C.media);
  await media.deleteMany({ _id: { $in: list } });
}

/* ---- signed public URLs (only used so Telegram can fetch a photo when a user shares it) ---- */
function shareKey(): string {
  return createHmac("sha256", "navagram-share-v1").update(env.BOT_TOKEN).digest("hex");
}
export function signMedia(mediaId: string): string {
  return createHmac("sha256", shareKey()).update(`m:${mediaId}`).digest("hex").slice(0, 24);
}
export function verifyMediaSig(mediaId: string, sig: unknown): boolean {
  return typeof sig === "string" && sig.length === 24 && signMedia(mediaId) === sig;
}
