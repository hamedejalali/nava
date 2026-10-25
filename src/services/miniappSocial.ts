import { InputFile, type Api } from "grammy";
import { getDb } from "../db/connect.js";
import { createModerationRecord } from "../db/models/imageModeration.js";
import { setProfilePhoto, type UserDoc } from "../db/models/user.js";
import { env } from "../config/env.js";
import { getBotSettings } from "../db/models/settings.js";
import { dictionary } from "../i18n/index.js";
import { glassButton, inlineKeyboard } from "../ui/keyboard.js";
import {  } from "../features/admin/constants.js";
import { getRecipients } from "./channelRouting.js";
import { adminCaption } from "../features/photo/moderation.js";
import { checkImage, type ModerationCheckResult } from "./sightengine.js";
import { botApi } from "./miniapp.js";
import { SocialError, findVisibleUser, isOfficial } from "./nava/common.js";
import { dropNotifs, ensureNotifIndexes, notifKey, pushNotif } from "./nava/notifs.js";
import { decodeImage } from "./nava/media.js";
import { runInTransaction, TxAbort } from "../db/tx.js";

/**
 * Navagram (نوا گرام) Mini App — the parts that live on the existing `users` document so the bot's
 * profile and the Mini App always show the same data: Mini-App @username, bio, profile-photo upload
 * (same moderation pipeline as the bot) and profile likes. Posts / stories / follows / gifts are in ./nava/.
 */

export { SocialError };

export const MAX_BIO = 300; // same limit as the bot's own bio editor
export const PHOTO_COOLDOWN_MS = 30_000;
/** Everybody needs 5+ characters; the owner and the numeric ids listed in the admin panel («یوزرنیم کوتاه») may use any length. */
export const USERNAME_MIN = 5;
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
      { key: { createdAt: -1, _id: 1 }, name: "explore_order" },
    ]);
    await db.collection("mini_posts").createIndexes([
      { key: { ownerId: 1, createdAt: -1 }, name: "owner_created" },
      { key: { createdAt: -1 }, name: "created" },
    ]);
    await db.collection("mini_comments").createIndexes([{ key: { postId: 1, createdAt: -1 }, name: "post_created" }, { key: { ownerId: 1, createdAt: -1 }, name: "owner_created" }]);
    await db.collection("users").createIndexes([{ key: { isPrivate: 1 }, name: "private_pages", partialFilterExpression: { isPrivate: true } }]);
    await db.collection("mini_follow_requests").createIndexes([
      { key: { toId: 1, createdAt: -1 }, name: "to_created" },
      { key: { fromId: 1 }, name: "from" },
    ]);
    await db.collection("mini_follows").createIndexes([
      { key: { followeeId: 1, createdAt: -1 }, name: "followee_created" },
      { key: { followerId: 1, createdAt: -1 }, name: "follower_created" },
    ]);
    await db.collection("mini_stories").createIndexes([
      { key: { ownerId: 1, expiresAt: 1 }, name: "owner_expires" },
      { key: { expiresAt: 1 }, name: "expires" },
      { key: { createdAt: 1 }, name: "created" },
    ]);
    await db.collection("mini_story_views").createIndexes([{ key: { storyId: 1 }, name: "story" }]);
    await db.collection("mini_gifts").createIndexes([
      { key: { receiverId: 1, createdAt: -1 }, name: "receiver_created" },
      { key: { pub: 1 }, name: "pub", partialFilterExpression: { pub: { $type: "string" } } },
      // a UNIQUE gift can exist only once: the database itself refuses a second copy
      { key: { giftId: 1 }, name: "unique_gift_once", unique: true, partialFilterExpression: { uniqueGift: true } },
    ]);
    await ensureNotifIndexes(db as any);
    await db.collection("post_reports").createIndexes([{ key: { postId: 1, createdAt: -1 }, name: "post_created" }]);
    await db.collection("mini_gift_defs").createIndexes([{ key: { createdAt: 1 }, name: "created" }]);
    await db.collection("mini_highlights").createIndexes([{ key: { ownerId: 1, createdAt: 1 }, name: "owner_created" }, { key: { storyIds: 1 }, name: "story_ids" }]);
    await db.collection("mini_recent_search").createIndexes([{ key: { userId: 1, at: -1 }, name: "user_at" }]);

    // Users who already had a profile photo before v1.16 get a "photo date" (their registration date) so
    // their profile-photo post has a proper place in the feed.
    const old = await db
      .collection<any>("users")
      .find({ profilePhotoFileId: { $type: "string", $ne: "" }, profilePhotoAt: { $exists: false } }, { projection: { _id: 1, createdAt: 1 } })
      .limit(500)
      .toArray();
    for (const u of old) await db.collection<any>("users").updateOne({ _id: u._id, profilePhotoAt: { $exists: false } }, { $set: { profilePhotoAt: u.createdAt ?? new Date() } });
  })().catch((err) => {
    ensured = false;
    console.error("[miniapp-social] index setup failed (will retry on next request):", err instanceof Error ? err.message : err);
  });
}

/* --------------------------------------------------------------- username */

/** Validates the format only (no DB). Returns the error code or null. */
export function usernameFormatError(raw: unknown, isStaff = false, shortOk = false): string | null {
  if (typeof raw !== "string") return "bad_chars";
  const u = raw.startsWith("@") ? raw.slice(1) : raw;
  if (u.length < (shortOk ? 1 : USERNAME_MIN)) return "too_short";
  if (u.length > USERNAME_MAX) return "too_long";
  if (!/^[A-Za-z0-9._]+$/.test(u)) return "bad_chars";
  if (u.startsWith(".") || u.endsWith(".") || u.includes("..")) return "bad_dots";
  if (/^\d+$/.test(u) && !(shortOk && u.length <= 4)) return "bad_chars"; // a long all-digit name looks like a Telegram id
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

/** May this person pick a username shorter than 5 characters? (the owner, or an id added in the admin panel) */
export async function shortUsernameAllowed(user: { _id: number }): Promise<boolean> {
  if (env.OWNER_ID !== undefined && user._id === env.OWNER_ID) return true;
  return ((await getBotSettings()).shortUsernameIds ?? []).includes(user._id);
}

/** the official account's name belongs to the owner only (even admins may not take it) */
function officialNameBlocked(user: { _id: number }, name: string): boolean {
  return name.toLowerCase() === "nava" && !(env.OWNER_ID !== undefined && user._id === env.OWNER_ID);
}

export async function checkUsername(user: UserDoc, raw: unknown, isStaff = false): Promise<{ available: boolean; reason?: string }> {
  if (typeof raw === "string" && officialNameBlocked(user, normalizeUsername(raw))) return { available: false, reason: "reserved" };
  const bad = usernameFormatError(raw, isStaff, await shortUsernameAllowed(user));
  if (bad) return { available: false, reason: bad };
  const name = normalizeUsername(raw as string);
  if (await isUsernameTaken(name.toLowerCase(), user._id)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Claims @username for the user. Uniqueness is enforced by a unique partial
 *  index, so two simultaneous claims can never both win. */
export async function setMiniUsername(user: UserDoc, raw: unknown, isStaff = false): Promise<string> {
  if (typeof raw === "string" && officialNameBlocked(user, normalizeUsername(raw))) throw new SocialError("reserved");
  const bad = usernameFormatError(raw, isStaff, await shortUsernameAllowed(user));
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

/* ------------------------------------------------------------------ likes */

/** Like / unlike a profile (= the "profile photo post"). Idempotent: `like=true` twice counts once,
 *  `like=false` twice un-counts once. Returns null when the profile is not visible to the viewer. */
export async function setLike(viewer: UserDoc, anonId: unknown, like: boolean): Promise<{ liked: boolean; likes: number } | null> {
  const target = await findVisibleUser(viewer._id, anonId, { includeSelf: true });
  if (!target) return null;
  const db = await getDb();
  const likes = db.collection<{ _id: string; createdAt: Date }>("profile_likes");
  const users = db.collection<UserDoc>("users");
  const key = `${viewer._id}:${target._id}`;
  let added = false;
  try {
    await runInTransaction(async (session) => {
      added = false;
      if (like) {
        const r = await likes.updateOne({ _id: key }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true, session });
        if (r.upsertedCount !== 1) return; // already liked -> no double count
        added = true;
        const inc = await users.updateOne({ _id: target._id }, { $inc: { likesCount: 1 } }, { session });
        if (inc.matchedCount !== 1) throw new TxAbort("user_gone");
      } else {
        const r = await likes.deleteOne({ _id: key }, { session });
        if (r.deletedCount === 1) await users.updateOne({ _id: target._id, likesCount: { $gt: 0 } } as any, { $inc: { likesCount: -1 } }, { session });
      }
    });
  } catch (err: any) {
    if (err instanceof TxAbort) return null;
    if (err?.code !== 11000) throw err; // a concurrent identical like won the race and was counted once
  }
  if (like && added) await pushNotif(notifKey.likeProfile(target._id, viewer._id), { userId: target._id, actorId: viewer._id, type: "like_profile", postId: `pp:${target.anonId}` });
  if (!like) await dropNotifs({ _id: notifKey.likeProfile(target._id, viewer._id) });
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

/** The owner's page and legal accounts only: free-text place, or none at all (empty = removed). */
export async function setLocation(user: UserDoc, provinceRaw: unknown, cityRaw: unknown): Promise<{ province: string | null; city: string | null }> {
  if (!isOfficial(user)) throw new SocialError("forbidden");
  const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : "");
  const province = clean(provinceRaw), city = clean(cityRaw);
  const db = await getDb();
  const u = db.collection<UserDoc>("users");
  await u.updateOne({ _id: user._id }, province || city ? { $set: { province: province || undefined, city: city || undefined } as any } : { $unset: { province: "", city: "" } });
  if (!province && city) await u.updateOne({ _id: user._id }, { $unset: { province: "" } });
  if (province && !city) await u.updateOne({ _id: user._id }, { $unset: { city: "" } });
  return { province: province || null, city: city || null };
}

/** The official coin next to the tick: any one emoji, or "" to remove it (owner's page and legal accounts). */
export async function setCoin(user: UserDoc, raw: unknown): Promise<string | null> {
  if (!isOfficial(user)) throw new SocialError("forbidden");
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t && (t.length > 12 || /[\u0000-\u001f<>&"']/.test(t))) throw new SocialError("bad_input");
  const db = await getDb();
  await db.collection<any>("users").updateOne({ _id: user._id }, { $set: { officialCoin: t } });
  return t || null;
}

/** A legal account's switch: may people send it chat requests? (The owner's «Nava» page never takes any.) */
export async function setOfficialChatOpen(user: UserDoc, open: boolean): Promise<boolean> {
  if (!isOfficial(user) || (env.OWNER_ID !== undefined && user._id === env.OWNER_ID)) throw new SocialError("forbidden");
  const db = await getDb();
  await db.collection<any>("users").updateOne({ _id: user._id }, { $set: { officialChatOpen: open } });
  return open;
}

/* ----------------------------------------------------------- photo upload */

export interface UploadDeps {
  api: Pick<Api, "sendPhoto" | "getFile" | "sendMessage">;
  check: (fileUrl: string) => Promise<ModerationCheckResult>;
  recipients: () => Promise<number[]>;
}

export { decodeImage };

/** Same moderation pipeline as a photo sent in the bot: Sightengine
 *  auto-approves safe photos, anything else waits for an admin. */
export async function uploadProfilePhoto(user: UserDoc, raw: unknown, deps?: Partial<UploadDeps>): Promise<"approved" | "pending"> {
  const buf = decodeImage(raw);
  const d: UploadDeps = {
    api: deps?.api ?? botApi(),
    check: deps?.check ?? checkImage,
    recipients: deps?.recipients ?? (() => getRecipients("profileEdit")),
  };
  // A legal account (a default member the owner runs): the photo goes to the OWNER's chat just to obtain a file_id, no approval.
  if (isOfficial(user) && !(env.OWNER_ID !== undefined && user._id === env.OWNER_ID) && env.OWNER_ID !== undefined) {
    const sent = await d.api.sendPhoto(env.OWNER_ID, new InputFile(buf, "profile.jpg"));
    await createModerationRecord({ type: "profile_photo", senderId: user._id, fileId: sent.photo[sent.photo.length - 1]!.file_id, status: "approved", aiScore: 0, aiClassification: "official" });
    await setProfilePhoto(user._id, sent.photo[sent.photo.length - 1]!.file_id);
    return "approved";
  }
  // The owner's own photo needs no approval: he is the approver.
  if (env.OWNER_ID !== undefined && user._id === env.OWNER_ID) {
    const sent = await d.api.sendPhoto(user._id, new InputFile(buf, "profile.jpg"));
    await createModerationRecord({ type: "profile_photo", senderId: user._id, fileId: sent.photo[sent.photo.length - 1]!.file_id, status: "approved", aiScore: 0, aiClassification: "owner" });
    await setProfilePhoto(user._id, sent.photo[sent.photo.length - 1]!.file_id);
    return "approved";
  }
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
