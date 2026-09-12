import type { Collection } from "mongodb";
import { getDb } from "../connect.js";
import { grantInitialBalanceIfNeeded } from "./relic.js";

export type UserLevel = "newcomer" | "normal" | "active" | "professional" | "special" | "legend";
export const USER_LEVELS: UserLevel[] = ["newcomer", "normal", "active", "professional", "special", "legend"];

export type Language = "fa" | "en" | "ar";
export type Gender = "male" | "female";

/**
 * Explicit onboarding state machine.
 *
 * This lets every handler verify server-side which step the user is
 * actually on, so a stale button/callback from an earlier step can never
 * be used to bypass or corrupt later steps (Feature 03 requirement).
 */
export type OnboardingStep =
  | "LANGUAGE_PENDING" // user record just created, no language yet
  | "GENDER_PENDING" // language chosen, waiting for gender
  | "GUIDE1_SHOWN" // gender permanently set, Guide 1 shown
  | "AGE_PENDING" // age question shown, waiting for age
  | "AGE_DONE" // age saved; province keyboard shown, waiting for province
  | "CITY_PENDING" // province saved; city keyboard shown, waiting for city
  | "NICKNAME_PENDING" // city saved; nickname prompt shown, waiting for nickname
  | "COMPLETED"; // nickname saved, onboarding fully finished

export interface UserDoc {
  /** Telegram numeric user ID is used directly as the Mongo _id (guarantees
   *  a single record per Telegram user via MongoDB's built-in _id uniqueness,
   *  no separate unique index or race-prone lookup-then-insert needed). */
  _id: number;
  telegramId: number;
  firstName: string;
  username?: string;

  /** Permanent, publicly-safe anonymous ID (e.g. "user_5RR1rD") — never
   *  reveals the Telegram ID, generated once at account creation. */
  anonId: string;

  /** Present while the user is in an active anonymous chat session; used
   *  both to route messages and to block entering another search/session. */
  activeChatSessionId?: string;

  bio?: string;
  likesCount?: number;
  /** Only ever set to an APPROVED photo's file_id — see
   *  src/db/models/photoModeration.ts. Never set directly from a raw
   *  upload. */
  profilePhotoFileId?: string;
  /** Cached live Relic balance — see src/db/models/relic.ts for the
   *  ledger that is the actual source of truth. */
  relicBalance?: number;
  relicInitialized?: boolean;

  /** New-user-quality/reputation level, shown on the profile. Defaults to
   *  "newcomer" and is only ever changed by the owner via the admin panel
   *  (see src/features/admin/levels.ts). */
  level?: UserLevel;
  /** Verified badge, toggled by an admin. */
  verified?: boolean;
  /** Ban state — enforced by middleware (src/bot.ts); a banned user gets
   *  only the ban notice, nothing else. */
  banned?: boolean;
  banReason?: string;
  /** Dynamically granted admin status (in addition to the static
   *  ADMIN_IDS env list and OWNER_ID) — set/unset by the owner via
   *  src/features/admin/moderators.ts. */
  isAdmin?: boolean;

  /** Which page of the (Reply Keyboard) city list the user is currently
   *  viewing during onboarding — reply-keyboard buttons have no callback
   *  data, so pagination state has to live somewhere durable. */
  cityPageIndex?: number;

  languageCode?: Language;
  gender?: Gender;
  age?: number;
  province?: string;
  city?: string;
  nickname?: string;
  /** Set by the /Exempt command — permanently bypasses the mandatory
   *  channel-join requirement for this user, per Feature 05's explicit
   *  "having trouble joining / don't want to join sponsor channels" escape
   *  hatch. */
  channelsExempt?: boolean;

  /** Message ID of the pinned promotional message shown once per user when
   *  they first enter the anonymous-chat section — prevents re-sending and
   *  re-pinning a duplicate on every visit. */
  pinnedPromoMessageId?: number;

  /** Message ID of the most recently sent "waiting for an answer" prompt
   *  (e.g. the age/province/city keyboard, or the nickname request). Used
   *  to reliably delete that message once answered/superseded, even when
   *  the answer arrives as a plain text message rather than a callback on
   *  that same message. */
  lastPromptMessageId?: number;

  onboardingStep: OnboardingStep;

  createdAt: Date;
  lastActivityAt: Date;
}

export async function usersCollection(): Promise<Collection<UserDoc>> {
  const db = await getDb();
  return db.collection<UserDoc>("users");
}

/** Must be called once during deployment setup (see README) or lazily on
 *  cold start. Safe to call repeatedly — createIndexes is idempotent. */
export async function ensureUserIndexes(): Promise<void> {
  const col = await usersCollection();
  await col.createIndexes([
    { key: { onboardingStep: 1 }, name: "onboardingStep_1" },
    { key: { languageCode: 1 }, name: "languageCode_1" },
    { key: { anonId: 1 }, name: "anonId_1", unique: true },
  ]);
}

const ANON_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateAnonId(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ANON_ID_CHARS[Math.floor(Math.random() * ANON_ID_CHARS.length)];
  return `user_${suffix}`;
}

/**
 * Idempotent "get or create" for a Telegram user.
 *
 * Uses a single atomic findOneAndUpdate with $setOnInsert + upsert, so
 * concurrent duplicate webhook deliveries or rapid /start presses can never
 * create two records or clobber existing fields (e.g. re-running /start
 * after a language was already selected must NOT reset progress).
 */
export async function getOrCreateUser(input: {
  telegramId: number;
  firstName: string;
  username?: string;
}): Promise<UserDoc & { __isNew?: boolean }> {
  const col = await usersCollection();
  const now = new Date();

  // Retry loop only matters in the extremely rare case of an anonId
  // collision on insert (unique index enforces it); a normal upsert of an
  // already-existing user never hits the catch branch.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const existedBefore = await col.findOne({ _id: input.telegramId }, { projection: { _id: 1 } });

      const result = await col.findOneAndUpdate(
        { _id: input.telegramId },
        {
          $setOnInsert: {
            _id: input.telegramId,
            telegramId: input.telegramId,
            onboardingStep: "LANGUAGE_PENDING",
            anonId: generateAnonId(),
            createdAt: now,
          },
          $set: {
            lastActivityAt: now,
            firstName: input.firstName,
            username: input.username,
          },
        },
        { upsert: true, returnDocument: "after" }
      );
      await grantInitialBalanceIfNeeded(input.telegramId, col);
      // __isNew is a non-persisted marker (never written to the DB) so
      // callers — specifically the "notify admins of a new user" hook in
      // src/bot.ts — can tell an insert from an ordinary lookup, without a
      // second round trip or a fragile timestamp comparison.
      return { ...(result as UserDoc), __isNew: !existedBefore };
    } catch (err: any) {
      // Duplicate key on anonId's unique index — regenerate and retry.
      if (err?.code === 11000 && String(err?.message ?? "").includes("anonId")) continue;
      throw err;
    }
  }
  throw new Error("[user] Failed to allocate a unique anonId after multiple attempts.");
}

export async function getUser(telegramId: number): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOne({ _id: telegramId });
}

/**
 * Sets/changes the user's language preference. Language is allowed to
 * change later via Settings, so this is a plain idempotent $set — applying
 * the same value twice (e.g. a double-tapped button) is harmless.
 *
 * When called during the very first onboarding step, it also advances
 * onboardingStep to GENDER_PENDING (only if the user is still exactly at
 * LANGUAGE_PENDING, so a later "change language in Settings" call does not
 * accidentally rewind onboarding progress).
 */
export async function setUserLanguage(telegramId: number, language: Language): Promise<UserDoc | null> {
  const col = await usersCollection();

  const advanced = await col.findOneAndUpdate(
    { _id: telegramId, onboardingStep: "LANGUAGE_PENDING" },
    { $set: { languageCode: language, onboardingStep: "GENDER_PENDING", lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );
  if (advanced) return advanced;

  // Not in the initial onboarding step anymore (e.g. changed later via
  // Settings) — just update the preference without touching onboardingStep.
  return col.findOneAndUpdate(
    { _id: telegramId },
    { $set: { languageCode: language, lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );
}

export type SetGenderResult =
  | { status: "saved"; user: UserDoc }
  | { status: "already_set"; user: UserDoc }
  | { status: "not_found" };

/**
 * Permanently sets the user's gender. Enforced ATOMICALLY at the database
 * level: the filter only matches documents where `gender` does not exist
 * yet, so under concurrent duplicate requests at most one write can ever
 * succeed, and gender can never be changed once set (Feature 02
 * requirement — server-side enforcement, not just UI).
 */
export async function setGenderOnce(telegramId: number, gender: Gender): Promise<SetGenderResult> {
  const col = await usersCollection();

  const updated = await col.findOneAndUpdate(
    { _id: telegramId, gender: { $exists: false } },
    { $set: { gender, onboardingStep: "GUIDE1_SHOWN", lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );

  if (updated) return { status: "saved", user: updated };

  const existing = await col.findOne({ _id: telegramId });
  if (!existing) return { status: "not_found" };
  return { status: "already_set", user: existing };
}

/** Marks that Guide 1 has been shown and the age question has been sent. */
export async function markAgeQuestionShown(telegramId: number): Promise<void> {
  const col = await usersCollection();
  await col.updateOne(
    { _id: telegramId, onboardingStep: "GUIDE1_SHOWN" },
    { $set: { onboardingStep: "AGE_PENDING", lastActivityAt: new Date() } }
  );
}

export type SetAgeResult = { status: "saved"; user: UserDoc } | { status: "wrong_step" } | { status: "not_found" };

/**
 * Saves age. Only accepted while onboardingStep is AGE_PENDING, which
 * prevents a stale age keyboard/message from an earlier session (or a
 * duplicate webhook delivery after the step already advanced) from
 * overwriting a value that was already saved.
 */
export async function setAgeOnce(telegramId: number, age: number): Promise<SetAgeResult> {
  const col = await usersCollection();

  const updated = await col.findOneAndUpdate(
    { _id: telegramId, onboardingStep: "AGE_PENDING" },
    { $set: { age, onboardingStep: "AGE_DONE", lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );

  if (updated) return { status: "saved", user: updated };

  const existing = await col.findOne({ _id: telegramId });
  if (!existing) return { status: "not_found" };
  return { status: "wrong_step" };
}

export type StepResult<T> = { status: "saved"; user: UserDoc } | { status: "wrong_step" } | { status: "not_found" };

/** Generic helper for the remaining strictly-ordered onboarding steps
 *  (province -> city -> nickname): only accepts the write while the user
 *  is exactly on `fromStep`, and atomically advances to `toStep`. This is
 *  the same anti-bypass / anti-duplicate pattern used for gender and age. */
async function advanceStep(
  telegramId: number,
  fromStep: OnboardingStep,
  toStep: OnboardingStep,
  fields: Partial<UserDoc>
): Promise<StepResult<UserDoc>> {
  const col = await usersCollection();

  const updated = await col.findOneAndUpdate(
    { _id: telegramId, onboardingStep: fromStep },
    { $set: { ...fields, onboardingStep: toStep, lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );
  if (updated) return { status: "saved", user: updated };

  const existing = await col.findOne({ _id: telegramId });
  if (!existing) return { status: "not_found" };
  return { status: "wrong_step" };
}

export async function setLastPromptMessageId(telegramId: number, messageId: number | undefined): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { lastPromptMessageId: messageId, lastActivityAt: new Date() } });
}

export async function setChannelsExempt(telegramId: number): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { channelsExempt: true, lastActivityAt: new Date() } });
}

export async function setPinnedPromoMessageId(telegramId: number, messageId: number): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { pinnedPromoMessageId: messageId } });
}

export async function setCityPageIndex(telegramId: number, page: number): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { cityPageIndex: page } });
}

/** Small generic escape hatch for setting arbitrary top-level fields —
 *  used sparingly (currently only by the owner/admin onboarding bypass). */
export async function usersCollectionDirectSet(telegramId: number, fields: Partial<UserDoc>): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: fields });
}

export async function setActiveChatSession(telegramId: number, sessionId: string | undefined): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { activeChatSessionId: sessionId } });
}

export async function incrementLikes(telegramId: number): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $inc: { likesCount: 1 } });
}

export async function setProfilePhoto(telegramId: number, fileId: string): Promise<void> {
  const col = await usersCollection();
  await col.updateOne({ _id: telegramId }, { $set: { profilePhotoFileId: fileId } });
}

export async function setUserLevel(telegramId: number, level: UserLevel): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOneAndUpdate({ _id: telegramId }, { $set: { level } }, { returnDocument: "after" });
}

export async function setVerified(telegramId: number, verified: boolean): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOneAndUpdate({ _id: telegramId }, { $set: { verified } }, { returnDocument: "after" });
}

export async function setBanned(telegramId: number, banned: boolean, reason?: string): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOneAndUpdate(
    { _id: telegramId },
    { $set: { banned, banReason: banned ? reason : undefined } },
    { returnDocument: "after" }
  );
}

export async function setAdminRole(telegramId: number, isAdminFlag: boolean): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOneAndUpdate({ _id: telegramId }, { $set: { isAdmin: isAdminFlag } }, { returnDocument: "after" });
}

export async function searchUsers(query: string, limit = 10): Promise<UserDoc[]> {
  const col = await usersCollection();
  const asNumber = Number(query.replace(/^@/, ""));
  const conditions: Record<string, unknown>[] = [
    { anonId: query.replace(/^@/, "") },
    { nickname: query },
    { username: query.replace(/^@/, "") },
  ];
  if (Number.isInteger(asNumber)) conditions.push({ _id: asNumber });
  return col.find({ $or: conditions }).limit(limit).toArray();
}

export async function listUsersPage(skip: number, limit: number): Promise<{ users: UserDoc[]; total: number }> {
  const col = await usersCollection();
  const [users, total] = await Promise.all([
    col.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments({}),
  ]);
  return { users, total };
}

export async function getUserStats(): Promise<{
  totalUsers: number;
  completedOnboarding: number;
  bannedUsers: number;
  activeChatsNow: number;
}> {
  const col = await usersCollection();
  const [totalUsers, completedOnboarding, bannedUsers, activeChatsNow] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ onboardingStep: "COMPLETED" }),
    col.countDocuments({ banned: true }),
    col.countDocuments({ activeChatSessionId: { $exists: true, $ne: undefined } }),
  ]);
  return { totalUsers, completedOnboarding, bannedUsers, activeChatsNow: Math.floor(activeChatsNow / 2) };
}

export async function getUserByAnonId(anonId: string): Promise<UserDoc | null> {
  const col = await usersCollection();
  return col.findOne({ anonId });
}

export function setProvinceOnce(telegramId: number, province: string) {
  return advanceStep(telegramId, "AGE_DONE", "CITY_PENDING", { province });
}

export function setCityOnce(telegramId: number, city: string) {
  return advanceStep(telegramId, "CITY_PENDING", "NICKNAME_PENDING", { city });
}

export function setNicknameOnce(telegramId: number, nickname: string) {
  return advanceStep(telegramId, "NICKNAME_PENDING", "COMPLETED", { nickname });
}
