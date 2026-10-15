import { levelDisplay } from "../../config/levels.js";
import { createEditRequest } from "../../db/models/editRequests.js";
import { getRequestRecipientIds } from "../../features/admin/constants.js";
import { isValidPersianNickname } from "../../features/onboarding/nickname.js";
import { MAX_AGE, MIN_AGE, notifyRecipientsOfEditRequest } from "../../features/matching/profileEdit.js";
import { botApi } from "../miniapp.js";
import { C, SocialError, col, findVisibleUser, hiddenOwnerIds, isAnonId, toBriefs, usersCol, type Brief } from "./common.js";
import { followCounts } from "./follow.js";
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
  followsMe: boolean;
  isMe: boolean;
  likes: number;
  liked: boolean;
  highlights: HighlightBrief[];
  /** none = can request · requested = a request of mine is waiting · busy = in another chat · me */
<<<<<<< HEAD
  chat: "none" | "requested" | "busy" | "me";
=======
  chat: "none" | "requested" | "busy" | "me" | "with_you";
>>>>>>> v1.11.0-wallet
  // ---- own profile only ----
  relic?: number;
  level?: string;
  hasPhoto?: boolean;
  photoPending?: boolean;
  pendingName?: string | null;
  pendingAge?: string | null;
}

export async function getProfile(viewer: any, anonId: unknown): Promise<ProfileView | null> {
  const owner = await findVisibleUser(viewer._id, anonId, { includeSelf: true });
  if (!owner) return null;
  const isMe = owner._id === viewer._id;
  const [brief] = await toBriefs(viewer._id, [owner]);
  const counts = await followCounts(owner._id);
  const follows = await col(C.follows);
  const liked = await (await col("profile_likes")).findOne({ _id: `${viewer._id}:${owner._id}` });
  const view: ProfileView = {
    ...brief!,
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
    highlights: await highlightBriefs(owner._id),
    chat: "none",
  };
  if (isMe) {
    view.chat = "me";
    const db = await usersCol();
    const fresh = (await db.findOne({ _id: owner._id })) ?? owner;
    const pendingPhoto = await (await col("image_moderation")).findOne({ senderId: owner._id, type: "profile_photo", status: "pending" });
    const reqs = await col("edit_requests");
    const pName = await reqs.findOne({ telegramId: owner._id, field: "nickname", status: "pending" });
    const pAge = await reqs.findOne({ telegramId: owner._id, field: "age", status: "pending" });
    view.relic = fresh.relicBalance ?? 0;
    view.level = levelDisplay(fresh.level);
    view.hasPhoto = !!fresh.profilePhotoFileId;
    view.photoPending = !!pendingPhoto;
    view.pendingName = pName ? String(pName.newValue) : null;
    view.pendingAge = pAge ? String(pAge.newValue) : null;
  } else {
<<<<<<< HEAD
    if (owner.activeChatSessionId) view.chat = "busy";
=======
    // they are chatting RIGHT NOW with the person who opened the profile: «در حال چت با شما هست»
    if (owner.activeChatSessionId && owner.activeChatSessionId === viewer.activeChatSessionId) view.chat = "with_you";
    else if (owner.activeChatSessionId) view.chat = "busy";
>>>>>>> v1.11.0-wallet
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
  return users.findOne({ _id: { $nin: [viewerId, ...hidden] }, onboardingStep: "COMPLETED", banned: { $ne: true }, activeChatSessionId: null, anonId });
}

/* ------------------------------------------------- name / age (owner-approved, like the bot) */

export async function requestProfileChange(
  user: any,
  field: "nickname" | "age",
  raw: unknown,
  deps: { api?: Parameters<typeof notifyRecipientsOfEditRequest>[0]; recipients?: () => Promise<number[]> } = {}
): Promise<{ status: "pending" }> {
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
  const admins = await (deps.recipients ?? getRequestRecipientIds)();
  if (admins.length === 0) throw new SocialError("unavailable");
  const reqs = await col("edit_requests");
  if (await reqs.findOne({ telegramId: user._id, field, status: "pending" })) throw new SocialError("pending_request");
  const previous = field === "nickname" ? (user.nickname ?? "-") : String(user.age ?? "-");
  const request = await createEditRequest(user._id, field, previous, value);
  await notifyRecipientsOfEditRequest(deps.api ?? botApi(), request._id, user, field, previous, value);
  return { status: "pending" };
}
