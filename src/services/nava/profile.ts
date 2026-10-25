import { env } from "../../config/env.js";
import { levelDisplay } from "../../config/levels.js";
import { createEditRequest } from "../../db/models/editRequests.js";
import {  } from "../../features/admin/constants.js";
import { getRecipients } from "../channelRouting.js";
import { isValidPersianNickname } from "../../features/onboarding/nickname.js";
import { MAX_AGE, MIN_AGE, notifyRecipientsOfEditRequest } from "../../features/matching/profileEdit.js";
import { botApi } from "../miniapp.js";
import { C, SocialError, col, findVisibleUser, hiddenOwnerIds, isAnonId, isOfficial, isStaffId, lockedOwnerIds, toBriefs, usersCol, type Brief } from "./common.js";
import { cleanBadges } from "../../config/badges.js";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import { hasPendingProfilePhoto } from "../../db/models/imageModeration.js";
import { countFollowRequests, followCounts } from "./follow.js";
import { countGifts } from "./gifts.js";
import { countPosts } from "./posts.js";
import { highlightBriefs, type HighlightBrief } from "./stories.js";

/** One user's profile page (self or somebody else) — everything the Instagram-style header needs. */
export interface ProfileView extends Brief {
  bio: string;
  age: number | string | null;
  province: string | null;
  city: string | null;
  followers: number;
  following: number;
  posts: number;
  gifts: number;
  iFollow: boolean;
  /** a follow request of mine is waiting for this (private) person's approval */
  requested: boolean;
  /** private page: posts / stories / follow lists are hidden from me until they approve */
  isPrivate: boolean;
  locked: boolean;
  followsMe: boolean;
  isMe: boolean;
  likes: number;
  liked: boolean;
  highlights: HighlightBrief[];
  /** none = can request · requested = a request of mine is waiting · busy = in another chat · me */
  chat: "none" | "requested" | "busy" | "me" | "with_you" | "official";
  // ---- own profile only ----
  /** follow requests waiting for my approval (private page) */
  requests?: number;
  relic?: number;
  level?: string;
  hasPhoto?: boolean;
  photoPending?: boolean;
  pendingName?: string | null;
  pendingAge?: string | null;
  /** the owner's own switches: what he hides from everybody else on his page (own view only) */
  hide?: ProfileHide;
  /** infinite XP (the owner) — the app shows ∞ instead of a number */
  unlimited?: boolean;
  /** this page belongs to the owner: he edits name / age / bio / photo directly, without approval */
  isOwnerPage?: boolean;
  /** legal accounts only (own view): are chat requests to this account switched on? */
  officialChat?: boolean;
  /** staff viewers only: the moderation state of this person */
  mod?: { banned: boolean; hasPhoto: boolean; badges: string[] };
  /** I blocked this person */
  blockedByMe?: boolean;
}

export const HIDE_KEYS = ["age", "bio", "location", "gifts", "stats"] as const;
export type HideKey = (typeof HIDE_KEYS)[number];
export type ProfileHide = Partial<Record<HideKey, boolean>>;

/** What a page owner hides from other people. The official «Nava» account hides age and location by default
 *  (it is a brand page, not a person); the owner can still switch them on with an explicit `false`. */
export function effectiveHide(owner: any): ProfileHide {
  const stored: ProfileHide = (owner.profileHide ?? {}) as ProfileHide;
  return isOfficial(owner) ? { age: true, location: true, ...stored } : stored;
}

export async function getProfile(viewer: any, anonId: unknown): Promise<ProfileView | null> {
  const owner = await findVisibleUser(viewer._id, anonId, { includeSelf: true });
  if (!owner) return null;
  const isMe = owner._id === viewer._id;
  const [brief] = await toBriefs(viewer._id, [owner]);
  const counts = await followCounts(owner._id);
  const follows = await col(C.follows);
  const liked = await (await col("profile_likes")).findOne({ _id: `${viewer._id}:${owner._id}` });
  const locked = !isMe && (await lockedOwnerIds(viewer._id)).includes(owner._id);
  const view: ProfileView = {
    ...brief!,
    isPrivate: !!owner.isPrivate,
    locked,
    requested: isMe ? false : !!(await (await col(C.followRequests)).findOne({ _id: `${viewer._id}:${owner._id}` })),
    bio: owner.bio ?? "",
    age: owner.age ?? null,
    province: owner.province ?? null,
    city: owner.city ?? null,
    followers: counts.followers,
    following: counts.following,
    posts: await countPosts(owner),
    gifts: await countGifts(owner._id),
    iFollow: isMe ? false : !!(await follows.findOne({ _id: `${viewer._id}:${owner._id}` })),
    followsMe: isMe ? false : !!(await follows.findOne({ _id: `${owner._id}:${viewer._id}` })),
    isMe,
    likes: owner.likesCount ?? 0,
    liked: !!liked,
    highlights: locked ? [] : await highlightBriefs(owner._id),
    chat: "none",
  };
  const hide: ProfileHide = effectiveHide(owner);
  if (!isMe) {
    // the page owner's own "don't show" switches (only the owner can set them)
    if (hide.age) view.age = null;
    if (hide.bio) view.bio = "";
    if (hide.location) { view.province = null; view.city = null; }
    if (hide.gifts) view.gifts = 0;
    if (hide.stats) { view.followers = 0; view.following = 0; view.likes = 0; }
  }
  if (isMe) {
    view.chat = "me";
    view.hide = hide;
    view.unlimited = hasUnlimitedXp(owner._id);
    view.isOwnerPage = isOfficial(owner);
    if (owner.official === true && !(env.OWNER_ID !== undefined && owner._id === env.OWNER_ID)) view.officialChat = owner.officialChatOpen === true;
    const db = await usersCol();
    const fresh = (await db.findOne({ _id: owner._id })) ?? owner;
    const pendingPhoto = await hasPendingProfilePhoto(owner._id);
    const reqs = await col("edit_requests");
    const pName = await reqs.findOne({ telegramId: owner._id, field: "nickname", status: "pending" });
    const pAge = await reqs.findOne({ telegramId: owner._id, field: "age", status: "pending" });
    view.relic = fresh.relicBalance ?? 0;
    view.requests = fresh.isPrivate ? await countFollowRequests(owner._id) : 0;
    view.level = levelDisplay(fresh.level);
    view.hasPhoto = !!fresh.profilePhotoFileId;
    view.photoPending = !!pendingPhoto;
    view.pendingName = pName ? String(pName.newValue) : null;
    view.pendingAge = pAge ? String(pAge.newValue) : null;
  } else {
    if (isStaffId(viewer._id)) view.mod = { banned: !!owner.banned, hasPhoto: !!owner.profilePhotoFileId, badges: cleanBadges(owner.badges) };
    // they are chatting RIGHT NOW with the person who opened the profile: «در حال چت با شما هست»
    if (isOfficial(owner) && !(owner.official === true && owner.officialChatOpen === true)) view.chat = "official";
    else if (owner.activeChatSessionId && owner.activeChatSessionId === viewer.activeChatSessionId) view.chat = "with_you";
    else if (owner.activeChatSessionId) view.chat = "busy";
    else {
      const pending = await (await col("chat_requests")).findOne({ fromId: viewer._id, toId: owner._id, status: "pending", expiresAt: { $gt: new Date() } });
      if (pending) view.chat = "requested";
    }
  }
  return view;
}

/** A user the viewer may send a chat request to: visible, free (not in a chat), NOT necessarily with a photo. */
export async function findRequestTarget(viewerId: number, anonId: unknown): Promise<any | null> {
  if (!isAnonId(anonId)) return null;
  const users = await usersCol();
  const hidden = await hiddenOwnerIds(viewerId);
  const t = await users.findOne({ _id: { $nin: [viewerId, ...hidden] }, onboardingStep: "COMPLETED", banned: { $ne: true }, activeChatSessionId: null, anonId });
  return t && (!isOfficial(t) || (t as any).officialChatOpen === true) ? t : null; // «Nava» never takes chat requests; a legal account only while its switch is on
}

/* ------------------------------------------------- name / age (owner-approved, like the bot) */

export async function requestProfileChange(
  user: any,
  field: "nickname" | "age",
  raw: unknown,
  deps: { api?: Parameters<typeof notifyRecipientsOfEditRequest>[0]; recipients?: () => Promise<number[]> } = {}
): Promise<{ status: "pending" } | { status: "applied"; value: string | null }> {
  // The owner's own page needs nobody's approval (he IS the approver): name and age are applied at once,
  // and the age is optional (an empty value removes it).
  if (isOfficial(user)) {
    const db = await usersCol();
    if (field === "nickname") {
      const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
      if (v.length < 1 || v.length > 32) throw new SocialError("bad_name");
      await db.updateOne({ _id: user._id }, { $set: { nickname: v } });
      return { status: "applied", value: v };
    }
    const txt = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    if (txt === "") {
      await db.updateOne({ _id: user._id }, { $unset: { age: "" } });
      return { status: "applied", value: null };
    }
    const n = /^\d{1,3}$/.test(txt) ? Number(txt) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new SocialError("bad_age");
    await db.updateOne({ _id: user._id }, { $set: { age: n } });
    return { status: "applied", value: String(n) };
  }
  let value: string;
  if (field === "nickname") {
    if (typeof raw !== "string" || !isValidPersianNickname(raw)) throw new SocialError("bad_name");
    value = raw.trim();
    if (value === (user.nickname ?? "")) throw new SocialError("same_value");
  } else {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(n) || n < MIN_AGE || n > MAX_AGE) throw new SocialError("bad_age");
    value = String(n);
    if (value === String(user.age ?? "")) throw new SocialError("same_value");
  }
  const admins = await (deps.recipients ?? (() => getRecipients("photo")))();
  if (admins.length === 0) throw new SocialError("unavailable");
  const reqs = await col("edit_requests");
  if (await reqs.findOne({ telegramId: user._id, field, status: "pending" })) throw new SocialError("pending_request");
  const previous = field === "nickname" ? (user.nickname ?? "-") : String(user.age ?? "-");
  const request = await createEditRequest(user._id, field, previous, value);
  await notifyRecipientsOfEditRequest(deps.api ?? botApi(), request._id, user, field, previous, value);
  return { status: "pending" };
}

/** Owner only: choose what the rest of the world sees on his page. Unknown keys are ignored. */
export async function setProfileVisibility(user: any, input: unknown): Promise<ProfileHide> {
  if (!isOfficial(user)) throw new SocialError("forbidden");
  const cur: ProfileHide = { ...((user.profileHide ?? {}) as ProfileHide) };
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const k of HIDE_KEYS) if (typeof src[k] === "boolean") cur[k] = src[k] as boolean;
  await (await usersCol()).updateOne({ _id: user._id }, { $set: { profileHide: cur } });
  return cur;
}
