import { Api } from "grammy";
import { env } from "../config/env.js";
import { getDb } from "../db/connect.js";
import { getBlockedCounterparts } from "../db/models/blocks.js";
import { listActiveChannels } from "../db/models/channel.js";
import { ensureChatRequestIndexes } from "../db/models/chatRequest.js";
import type { UserDoc } from "../db/models/user.js";
import { verifyTelegramWebAppInitData } from "../utils/telegramWebApp.js";

/** Mini App sessions are allowed to stay open for a few hours. */
export const MINIAPP_INITDATA_MAX_AGE_SECONDS = 3 * 3600;
export const MAX_EXCLUDE = 200;

let api: Api | null = null;
export function botApi(): Api {
  if (!api) api = new Api(env.BOT_TOKEN);
  return api;
}

let indexesEnsured = false;
export function ensureMiniappIndexesOnce(): void {
  if (indexesEnsured) return;
  indexesEnsured = true;
  ensureChatRequestIndexes().catch((err) => {
    indexesEnsured = false;
    console.error("[miniapp] index setup failed (will retry on next request):", err);
  });
}

export type ViewerResult =
  | { ok: true; user: UserDoc }
  | { ok: false; status: number; error: string };

/** Validates initData (HMAC against the bot token) and loads the viewer.
 *  The Telegram id is NEVER taken from anywhere but the signed initData. */
export async function authenticateViewer(initData: unknown): Promise<ViewerResult> {
  if (typeof initData !== "string" || !initData || initData.length > 4096) return { ok: false, status: 401, error: "unauthorized" };
  const tg = verifyTelegramWebAppInitData(initData, env.BOT_TOKEN, MINIAPP_INITDATA_MAX_AGE_SECONDS);
  if (!tg) return { ok: false, status: 401, error: "unauthorized" };

  const db = await getDb();
  const user = await db.collection<UserDoc>("users").findOne({ _id: tg.id });
  if (!user || user.onboardingStep !== "COMPLETED") return { ok: false, status: 403, error: "not_registered" };
  if (user.banned) return { ok: false, status: 403, error: "banned" };
  return { ok: true, user };
}

/** Same live force-join rule the bot applies (admin-exempt users skip it). */
export async function viewerHasJoinedChannels(user: UserDoc): Promise<boolean> {
  if (user.channelsExempt) return true;
  const channels = await listActiveChannels();
  for (const channel of channels) {
    try {
      const member = await botApi().getChatMember(channel.chatRef, user._id);
      if (!["member", "administrator", "creator"].includes(member.status)) return false;
    } catch (err) {
      console.error(`[miniapp] getChatMember failed for channel ${channel._id}:`, err);
      return false; // fail closed, same as the bot
    }
  }
  return true;
}

/** Mongo filter for "a registered user whose photo may be shown". */
export function eligibleCandidateFilter(viewerId: number, blocked: number[], excludeAnonIds: string[]): Record<string, unknown> {
  return {
    _id: { $nin: [viewerId, ...blocked] },
    onboardingStep: "COMPLETED",
    banned: { $ne: true },
    activeChatSessionId: null,
    profilePhotoFileId: { $type: "string", $ne: "" },
    anonId: { $nin: excludeAnonIds },
  };
}

export function sanitizeExclude(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length <= 32).slice(0, MAX_EXCLUDE);
}

/** One random eligible profile (photo-only), or null when none is left. */
export async function pickCandidate(viewerId: number, excludeAnonIds: string[]): Promise<{ anonId: string } | null> {
  const db = await getDb();
  const blocked = await getBlockedCounterparts(viewerId);
  const [doc] = await db
    .collection<UserDoc>("users")
    .aggregate<{ anonId: string }>([
      { $match: eligibleCandidateFilter(viewerId, blocked, excludeAnonIds) },
      { $sample: { size: 1 } },
      { $project: { _id: 0, anonId: 1 } },
    ])
    .toArray();
  return doc ?? null;
}

/** A target by anonId, only if it is currently eligible for the viewer. */
export async function findEligibleTarget(viewerId: number, anonId: unknown): Promise<UserDoc | null> {
  if (typeof anonId !== "string" || !anonId || anonId.length > 32) return null;
  const db = await getDb();
  const blocked = await getBlockedCounterparts(viewerId);
  return db.collection<UserDoc>("users").findOne({ ...eligibleCandidateFilter(viewerId, blocked, []), anonId } as any);
}

/** Streams a Telegram file (by file_id) back — used for photos so the bot
 *  token never reaches the browser. */
export async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const file = await botApi().getFile(fileId);
  if (!file.file_path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const lower = file.file_path.toLowerCase();
  const contentType = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { buffer, contentType };
}

