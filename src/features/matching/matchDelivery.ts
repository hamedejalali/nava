import { GrammyError } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { getDb } from "../../db/connect.js";
import { getUser } from "../../db/models/user.js";
import type { ChatSessionDoc } from "../../db/models/chatSession.js";
import { closeSessionAtomic } from "../../db/models/sessionClose.js";
import {
  backoffMs,
  findDueDeliveries,
  getDelivery,
  leaseDelivery,
  MAX_DELIVERY_ATTEMPTS,
  updateDelivery,
  type MatchDeliveryDoc,
} from "../../db/models/matchDelivery.js";
import { buildChatControlsKeyboard, CHAT_CONTROL_LABELS } from "./chatUi.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";

type Api = NavaContext["api"];

/** Shown to BOTH people when a chat REQUEST (from the Mini App) is accepted — a random-search match
 *  keeps the "found you a partner" text, but here nobody was "found": the request was accepted. */
export const CHAT_REQUEST_ACCEPTED_TEXT = "✅ درخواست چت قبول شد و الان می‌تونید باهم صحبت کنید.";

export const UNDELIVERED_NOTICE = "⚠️ مخاطبت در دسترس نبود و اتصال لغو شد. رلیکت برگشت داده شد؛ می‌تونی دوباره جستجو کنی.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How a failed Telegram call must be treated:
 *  - "unreachable": the person can NEVER get a message (blocked the bot, account deleted, chat gone);
 *  - "rejected":    Telegram understood us but refused THIS content (4xx other than 429, e.g. an invalid
 *                   keyboard button style) — retrying the identical request can never work, a simpler one might;
 *  - "transient":   network error, timeout, 429 rate limit, 5xx — the same request may well work later.
 */
export type SendErrorClass = "unreachable" | "rejected" | "transient";

export function classifySendError(err: unknown): SendErrorClass {
  if (err instanceof GrammyError) {
    if (err.error_code === 403) return "unreachable";
    if (err.error_code === 400 && /chat not found|user is deactivated|bot was blocked|PEER_ID_INVALID/i.test(err.description)) return "unreachable";
    if (err.error_code >= 400 && err.error_code < 500 && err.error_code !== 429) return "rejected";
  }
  return "transient";
}

async function sendOnce<T>(fn: () => Promise<T>): Promise<T> {
  // one quick in-process retry for a transient blip; everything beyond that is the durable retry's job
  try {
    return await fn();
  } catch (err) {
    if (classifySendError(err) !== "transient") throw err;
    await sleep(250);
    return fn();
  }
}

/** A keyboard with NO button styles / custom-emoji icons — the least likely to be rejected by Telegram. */
export function buildSimpleChatControlsKeyboard(lang: Language, safeChatEnabled = false) {
  const t = dictionary(lang);
  const profileLabel = requireLocked(lang, "matching.partnerProfileButton", t.matching.partnerProfileButton) || CHAT_CONTROL_LABELS.partnerProfile;
  const endChatLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton) || CHAT_CONTROL_LABELS.endChat;
  const safeChatLabel = safeChatEnabled ? CHAT_CONTROL_LABELS.safeChatOff : CHAT_CONTROL_LABELS.safeChatOn;
  return {
    keyboard: [[{ text: profileLabel }, { text: safeChatLabel }], [{ text: endChatLabel }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

type Outcome = "delivered" | "degraded" | "retry" | "unreachable";

/**
 * Sends the "you are connected" notice and the chat controls to one person, with a fallback ladder so a
 * rejected keyboard never costs the person their chat:
 *   1. full controls (styled reply keyboard + <blockquote> warning)
 *   2. simple controls (plain reply keyboard + plain warning)
 *   3. plain warning text that mentions /end (always works while the person is reachable)
 * `foundSent` makes a retry send only what is still missing.
 */
async function sendNotices(api: Api, d: MatchDeliveryDoc, lang: Language): Promise<{ outcome: Outcome; foundSent: boolean; error?: string }> {
  const t = dictionary(lang);
  const found = d.kind === "request" ? CHAT_REQUEST_ACCEPTED_TEXT : requireLocked(lang, "matching.foundPartner", t.matching.foundPartner);
  const warning = requireLocked(lang, "matching.trustWarning", t.matching.trustWarning);
  let foundSent = !!d.foundSent;

  const classify = (err: unknown): { outcome: Outcome; error: string } => {
    const c = classifySendError(err);
    return { outcome: c === "unreachable" ? "unreachable" : "retry", error: `${c}:${err instanceof Error ? err.name : "unknown"}` };
  };

  if (!foundSent) {
    try {
      await sendOnce(() => api.sendMessage(d.userId, found));
      foundSent = true;
      await updateDelivery(d._id, { foundSent: true }, false);
    } catch (err) {
      return { ...classify(err), foundSent };
    }
  }

  // 1) full controls
  try {
    await sendOnce(() => api.sendMessage(d.userId, `<blockquote>${warning}</blockquote>`, { parse_mode: "HTML", reply_markup: buildChatControlsKeyboard(lang, false) }));
    return { outcome: "delivered", foundSent };
  } catch (err) {
    if (classifySendError(err) !== "rejected") return { ...classify(err), foundSent };
    console.error("[match] full chat controls rejected by Telegram, trying simple keyboard");
  }

  // 2) simple keyboard, plain text
  try {
    await sendOnce(() => api.sendMessage(d.userId, warning, { reply_markup: buildSimpleChatControlsKeyboard(lang, false) }));
    return { outcome: "degraded", foundSent };
  } catch (err) {
    if (classifySendError(err) !== "rejected") return { ...classify(err), foundSent };
    console.error("[match] simple chat controls rejected by Telegram, falling back to plain text");
  }

  // 3) plain text only; /end is handled by registerChatControls so the person is never trapped
  try {
    await sendOnce(() => api.sendMessage(d.userId, `${warning}\n\nبرای پایان دادن به چت هر وقت خواستی /end رو بفرست.`));
    return { outcome: "degraded", foundSent };
  } catch (err) {
    return { ...classify(err), foundSent };
  }
}

/**
 * One person can never receive the chat (blocked the bot / account gone): end the session ATOMICALLY
 * (session closed, both freed, both refunded, in one transaction) and tell the other person. If the
 * transaction fails the session simply stays active and this delivery stays pending, so a later retry
 * finishes the job — nothing is half-done, nobody is refunded twice.
 */
async function undoUndelivered(api: Api, d: MatchDeliveryDoc): Promise<boolean> {
  const result = await closeSessionAtomic(d.sessionId, d.userId, (s: ChatSessionDoc) => [s.userA, s.userB], "undelivered");
  const db = await getDb();
  await db.collection<MatchDeliveryDoc>("match_deliveries").updateMany(
    { sessionId: d.sessionId, state: "pending", _id: { $ne: d._id } },
    { $set: { state: "void", updatedAt: new Date() }, $unset: { leaseUntil: "" } },
  );
  if (result.status === "ended") {
    const otherId = result.session.userA === d.userId ? result.session.userB : result.session.userA;
    const other = await getUser(otherId).catch(() => null);
    const l: Language = other?.languageCode ?? "fa";
    await api.sendMessage(otherId, UNDELIVERED_NOTICE, { reply_markup: buildMainMenuReplyKeyboard(l) }).catch(() => {});
  }
  return true;
}

/**
 * Works on ONE delivery record. Never throws. Safe to call concurrently from any number of invocations:
 * the MongoDB lease gives exactly one of them the work, the others return "skipped".
 */
export async function deliverOne(api: Api, id: string, opts: { force?: boolean } = {}): Promise<"delivered" | "degraded" | "retry" | "unreachable" | "gave_up" | "void" | "skipped"> {
  let d: MatchDeliveryDoc | null = null;
  try {
    d = await leaseDelivery(id, { force: opts.force });
    if (!d) return "skipped";

    const db = await getDb();
    const session = await db.collection<ChatSessionDoc>("chat_sessions").findOne({ _id: d.sessionId });
    if (!session || !session.active) {
      await updateDelivery(d._id, { state: "void" });
      return "void";
    }

    const user = await getUser(d.userId).catch(() => null);
    const lang: Language = user?.languageCode ?? "fa";
    const r = await sendNotices(api, d, lang);

    if (r.outcome === "delivered" || r.outcome === "degraded") {
      await updateDelivery(d._id, { state: r.outcome === "delivered" ? "delivered" : "degraded", foundSent: true });
      return r.outcome;
    }
    if (r.outcome === "unreachable") {
      await undoUndelivered(api, d);
      await updateDelivery(d._id, { state: "unreachable", lastError: r.error });
      return "unreachable";
    }
    // transient: bounded retries with backoff; the chat itself is NOT touched
    if (d.attempts >= MAX_DELIVERY_ATTEMPTS) {
      console.error("[match] delivery gave up after", d.attempts, "attempts:", r.error);
      await updateDelivery(d._id, { state: "gave_up", foundSent: r.foundSent, lastError: r.error });
      return "gave_up";
    }
    await updateDelivery(d._id, { foundSent: r.foundSent, lastError: r.error, nextAttemptAt: new Date(Date.now() + backoffMs(d.attempts)) });
    return "retry";
  } catch (err) {
    // e.g. the database failed mid-way: the lease simply expires and the record is retried later
    console.error("[match] delivery step failed (will be retried):", err instanceof Error ? err.name : "unknown");
    return "retry";
  }
}

/** Inline attempt for a session that was JUST created (both people, in parallel). Never throws. */
export async function deliverSession(api: Api, sessionId: string, userIds: number[]): Promise<void> {
  await Promise.allSettled(userIds.map((u) => deliverOne(api, `${sessionId}:${u}`, { force: true })));
}

/** Retry pass (cron / opportunistic): handles deliveries that are due. Never throws. */
export async function processDueDeliveries(api: Api, limit = 5): Promise<{ processed: number }> {
  try {
    const due = await findDueDeliveries(limit);
    await Promise.allSettled(due.map((d) => deliverOne(api, d._id)));
    return { processed: due.length };
  } catch (err) {
    console.error("[match] processDueDeliveries failed:", err instanceof Error ? err.name : "unknown");
    return { processed: 0 };
  }
}

let lastOpportunisticRun = 0;
/** Called after webhook requests: runs a retry pass at most every 20 s per warm instance (optimization only —
 *  correctness comes from the MongoDB lease, so concurrent instances / the cron cannot double-deliver). */
export async function maybeProcessDueDeliveries(api: Api, minGapMs = 20_000): Promise<void> {
  const now = Date.now();
  if (now - lastOpportunisticRun < minGapMs) return;
  lastOpportunisticRun = now;
  await processDueDeliveries(api);
}

export { getDelivery };
