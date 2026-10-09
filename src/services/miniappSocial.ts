import { InputFile, type Api } from "grammy";
import { getDb } from "../db/connect.js";
import { getBlockedCounterparts } from "../db/models/blocks.js";
import { createModerationRecord } from "../db/models/imageModeration.js";
import { setProfilePhoto, type UserDoc } from "../db/models/user.js";
import { levelDisplay } from "../config/levels.js";
import { env } from "../config/env.js";
import { dictionary } from "../i18n/index.js";
import { glassButton, inlineKeyboard } from "../ui/keyboard.js";
import { getRequestRecipientIds } from "../features/admin/constants.js";
import { adminCaption } from "../features/photo/moderation.js";
import { checkImage, type ModerationCheckResult } from "./sightengine.js";
import { botApi, eligibleCandidateFilter } from "./miniapp.js";

/**
 * Instagram-style Mini App backend (v1.15.0): Mini-App-only @username,
 * feed / explore / search over registered users with an approved photo,
 * likes, bio and photo upload. Everything is stored on the existing `users`
 * document so the bot's profile reflects the same data.
 */

export class SocialError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const PAGE_SIZE = 12;
export const MAX_BIO = 150;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const PHOTO_COOLDOWN_MS = 30_000;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
const RESERVED = new Set(["admin", "administrator", "nava", "support", "owner", "moderator", "official", "bot", "telegram", "null", "undefined", "root"]);

/* ---------------------------------------------------------------- indexes */

let ensured = false;
export function ensureSocialIndexesOnce(): void {
  if (ensured) return;
  ensured = true;
  (async () => {
    const db = await getDb();
    await db.collection("users").createIndexes([
      {
        key: { miniUsernameLower: 1 },
        name: "mini_username_unique",
        unique: true,
        partialFilterExpression: { miniUsernameLower: { $type: "string" } },
      },
    ]);
  })().catch((err) => {
    ensured = false;
    console.error("[miniapp-social] index setup failed (will retry on next request):", err instanceof Error ? err.message : err);
  });
}

/* --------------------------------------------------------------- username */

/** Validates the format only (no DB). Returns the error code or null. */
export function usernameFormatError(raw: unknown, isStaff = false): string | null {
  if (typeof raw !== "string") return "bad_chars";
  const u = raw.startsWith("@") ? raw.slice(1) : raw;
  if (u.length < USERNAME_MIN) return "too_short";
  if (u.length > USERNAME_MAX) return "too_long";
  if (!/^[A-Za-z0-9._]+$/.test(u)) return "bad_chars";
  if (u.startsWith(".") || u.endsWith(".") || u.includes("..")) return "bad_dots";
  if (/^\d+$/.test(u)) return "bad_chars"; // all digits looks like a Telegram id
  if (!isStaff && RESERVED.has(u.toLowerCase())) return "reserved";
  return null;
}

export function normalizeUsername(raw: string): string {
  return (raw.startsWith("@") ? raw.slice(1) : raw).trim();
}

export async function isUsernameTaken(lower: string, exceptUserId?: number): Promise<boolean> {
  const db = await getDb();
  const hit = await db.collection<any>("users").findOne({ miniUsernameLower: lower }, { projection: { _id: 1 } });
  return !!hit && hit._id !== exceptUserId;
}

export async function checkUsername(user: UserDoc, raw: unknown, isStaff = false): Promise<{ available: boolean; reason?: string }> {
  const bad = usernameFormatError(raw, isStaff);
  if (bad) return { available: false, reason: bad };
  const name = normalizeUsername(raw as string);
  if (await isUsernameTaken(name.toLowerCase(), user._id)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Claims @username for the user. Uniqueness is enforced by a unique partial
 *  index, so two simultaneous claims can never both win. */
export async function setMiniUsername(user: UserDoc, raw: unknown, isStaff = false): Promise<string> {
  const bad = usernameFormatError(raw, isStaff);
  if (bad) throw new SocialError(bad);
  const name = normalizeUsername(raw as string);
  const lower = name.toLowerCase();
  if (await isUsernameTaken(lower, user._id)) throw new SocialError("taken");
  const db = await getDb();
  try {
    await db.collection<any>("users").updateOne({ _id: user._id }, { $set: { miniUsername: name, miniUsernameLower: lower } });
  } catch (err: any) {
    if (err?.code === 11000) throw new SocialError("taken");
    throw err;
  }
  return name;
}

/* ------------------------------------------------------------------ cards */

export interface Card {
  id: string; // public Nava ID (anonId) — Telegram ids never leave the server
  username: string | null;
  name: string;
  verified: boolean;
  age: number | string | null;
  province: string | null;
  city: string | null;
  bio: string;
  likes: number;
  liked: boolean;
}

async function likedSet(viewerId: number, targets: UserDoc[]): Promise<Set<number>> {
  if (!targets.length) return new Set();
  const db = await getDb();
  const rows = await db
    .collection<{ _id: string }>("profile_likes")
    .find({ _id: { $in: targets.map((t) => `${viewerId}:${t._id}`) } })
    .toArray();
  return new Set(rows.map((r) => Number(String(r._id).split(":")[1])));
}

export async function toCards(viewerId: number, docs: UserDoc[]): Promise<Card[]> {
  const liked = await likedSet(viewerId, docs);
  return docs.map((u: any) => ({
    id: u.anonId,
    username: u.miniUsername ?? null,
    name: u.nickname ?? "-",
    verified: !!u.verified,
    age: u.age ?? null,
    province: u.province ?? null,
    city: u.city ?? null,
    bio: u.bio ?? "",
    likes: u.likesCount ?? 0,
    liked: liked.has(u._id),
  }));
}

async function baseFilter(viewerId: number): Promise<Record<string, unknown>> {
  const blocked = await getBlockedCounterparts(viewerId);
  return eligibleCandidateFilter(viewerId, blocked, []);
}

export type ListOrder = "new" | "top";

export async function listUsers(viewerId: number, opts: { order: ListOrder; offset: number }): Promise<{ items: Card[]; hasMore: boolean }> {
  const db = await getDb();
  const offset = Math.max(0, Math.min(10_000, Math.floor(opts.offset) || 0));
  const sort: Record<string, 1 | -1> = opts.order === "top" ? { likesCount: -1, _id: -1 } : { _id: -1 };
  const docs = await db
    .collection<UserDoc>("users")
    .find(await baseFilter(viewerId) as any)
    .sort(sort)
    .skip(offset)
    .limit(PAGE_SIZE + 1)
    .toArray();
  const hasMore = docs.length > PAGE_SIZE;
  return { items: await toCards(viewerId, docs.slice(0, PAGE_SIZE)), hasMore };
}

export async function getCard(viewerId: number, anonId: unknown): Promise<Card | null> {
  if (typeof anonId !== "string" || !anonId || anonId.length > 32) return null;
  const db = await getDb();
  const doc = await db.collection<UserDoc>("users").findOne({ ...(await baseFilter(viewerId)), anonId } as any);
  return doc ? (await toCards(viewerId, [doc]))[0]! : null;
}

export async function searchUsers(viewerId: number, rawQuery: unknown): Promise<Card[]> {
  if (typeof rawQuery !== "string") return [];
  const q = normalizeUsername(rawQuery.trim()).toLowerCase();
  if (!q || q.length > USERNAME_MAX || !/^[a-z0-9._]+$/.test(q)) return [];
  const db = await getDb();
  const docs = await db
    .collection<UserDoc>("users")
    .find({ ...(await baseFilter(viewerId)), miniUsernameLower: { $gte: q, $lt: q + "￿" } } as any)
    .sort({ miniUsernameLower: 1 })
    .limit(30)
    .toArray();
  return toCards(viewerId, docs);
}

/* ------------------------------------------------------------------ likes */

/** Idempotent: `like=true` twice counts once, `like=false` twice un-counts once. */
export async function setLike(viewer: UserDoc, anonId: unknown, like: boolean): Promise<{ liked: boolean; likes: number } | null> {
  if (typeof anonId !== "string" || !anonId || anonId.length > 32) return null;
  const db = await getDb();
  const target = await db.collection<UserDoc>("users").findOne({ ...(await baseFilter(viewer._id)), anonId } as any);
  if (!target) return null;
  const likes = db.collection<{ _id: string; createdAt: Date }>("profile_likes");
  const users = db.collection<UserDoc>("users");
  const key = `${viewer._id}:${target._id}`;
  if (like) {
    try {
      await likes.insertOne({ _id: key, createdAt: new Date() });
      await users.updateOne({ _id: target._id }, { $inc: { likesCount: 1 } });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already liked -> no double count
    }
  } else {
    const r = await likes.deleteOne({ _id: key });
    if (r.deletedCount === 1) await users.updateOne({ _id: target._id, likesCount: { $gt: 0 } } as any, { $inc: { likesCount: -1 } });
  }
  const fresh = await users.findOne({ _id: target._id }, { projection: { likesCount: 1 } });
  const nowLiked = !!(await likes.findOne({ _id: key }));
  return { liked: nowLiked, likes: fresh?.likesCount ?? 0 };
}

/* ---------------------------------------------------------------- profile */

export function cleanBio(raw: unknown): string {
  if (typeof raw !== "string") throw new SocialError("bad_bio");
  const s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮]/g, "").replace(/\r\n?/g, "\n").trim();
  if ([...s].length > MAX_BIO) throw new SocialError("bio_too_long");
  return s.replace(/\n{3,}/g, "\n\n");
}

export async function setBio(user: UserDoc, raw: unknown): Promise<string> {
  const bio = cleanBio(raw);
  const db = await getDb();
  await db.collection<UserDoc>("users").updateOne({ _id: user._id }, { $set: { bio } });
  return bio;
}

export async function myProfile(user: UserDoc) {
  const db = await getDb();
  const fresh = (await db.collection<any>("users").findOne({ _id: user._id })) ?? user;
  const pending = await db.collection<any>("image_moderation").findOne({ senderId: user._id, type: "profile_photo", status: "pending" });
  return {
    id: fresh.anonId,
    username: fresh.miniUsername ?? null,
    name: fresh.nickname ?? "-",
    verified: !!fresh.verified,
    age: fresh.age ?? null,
    province: fresh.province ?? null,
    city: fresh.city ?? null,
    bio: fresh.bio ?? "",
    likes: fresh.likesCount ?? 0,
    relic: fresh.relicBalance ?? 0,
    level: levelDisplay(fresh.level),
    hasPhoto: !!fresh.profilePhotoFileId,
    photoPending: !!pending,
  };
}

/* ----------------------------------------------------------- photo upload */

export interface UploadDeps {
  api: Pick<Api, "sendPhoto" | "getFile" | "sendMessage">;
  check: (fileUrl: string) => Promise<ModerationCheckResult>;
  recipients: () => Promise<number[]>;
}

export function decodeImage(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length > MAX_PHOTO_BYTES * 1.4) throw new SocialError("bad_image");
  const b64 = raw.replace(/^data:image\/(jpeg|png|webp);base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new SocialError("bad_image");
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100 || buf.length > MAX_PHOTO_BYTES) throw new SocialError("bad_image");
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (!jpeg && !png && !webp) throw new SocialError("bad_image");
  return buf;
}

/** Same moderation pipeline as a photo sent in the bot: Sightengine
 *  auto-approves safe photos, anything else waits for an admin. */
export async function uploadProfilePhoto(user: UserDoc, raw: unknown, deps?: Partial<UploadDeps>): Promise<"approved" | "pending"> {
  const buf = decodeImage(raw);
  const d: UploadDeps = {
    api: deps?.api ?? botApi(),
    check: deps?.check ?? checkImage,
    recipients: deps?.recipients ?? getRequestRecipientIds,
  };
  const admins = await d.recipients();
  if (admins.length === 0) throw new SocialError("unavailable");

  // Atomic per-user cooldown (also stops double-submits).
  const db = await getDb();
  const now = Date.now();
  const claimed = await db.collection<any>("users").updateOne(
    { _id: user._id, $or: [{ miniPhotoAt: { $exists: false } }, { miniPhotoAt: { $lt: new Date(now - PHOTO_COOLDOWN_MS) } }] },
    { $set: { miniPhotoAt: new Date(now) } }
  );
  if (claimed.matchedCount === 0) throw new SocialError("too_fast");

  const t = dictionary(user.languageCode ?? "fa");
  // The upload to the user's own chat is what gives us a Telegram file_id.
  const sent = await d.api.sendPhoto(user._id, new InputFile(buf, "profile.jpg"));
  const largest = sent.photo[sent.photo.length - 1]!;
  const file = await d.api.getFile(largest.file_id);
  const check = await d.check(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);

  if (!check.flagged) {
    await createModerationRecord({ type: "profile_photo", senderId: user._id, fileId: largest.file_id, status: "approved", aiScore: check.score, aiClassification: check.classification });
    await setProfilePhoto(user._id, largest.file_id);
    await d.api.sendMessage(user._id, t.photo.approved).catch(() => {});
    return "approved";
  }

  const request = await createModerationRecord({ type: "profile_photo", senderId: user._id, fileId: largest.file_id, status: "pending", aiScore: check.score, aiClassification: check.classification });
  const keyboard = inlineKeyboard([[glassButton("تأیید عکس", `modimg:approve:${request._id}`, "success"), glassButton("عدم تأیید عکس", `modimg:reject:${request._id}`, "danger")]]);
  for (const adminId of admins) {
    await d.api.sendPhoto(adminId, largest.file_id, { caption: adminCaption(user), reply_markup: keyboard }).catch(() => {});
  }
  await d.api.sendMessage(user._id, t.photo.submittedForReview).catch(() => {});
  return "pending";
}
