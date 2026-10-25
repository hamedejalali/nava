import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { newSessionId, getSession, incrementMessageCount, type ChatSessionDoc } from "../../db/models/chatSession.js";
import { closeSessionAtomic } from "../../db/models/sessionClose.js";
import { insertDeliveries, newDeliveryDocs } from "../../db/models/matchDelivery.js";
import { voidSearchNotices } from "../../db/models/searchNotice.js";
import { getBlockedCounterparts } from "../../db/models/blocks.js";
import type { MatchQueueDoc, SearchType } from "../../db/models/matchQueue.js";
import { pickSeedFor } from "../../db/models/seeds.js";
import type { UserDoc } from "../../db/models/user.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { textEmoji } from "../../config/emojis.js";
import { env } from "../../config/env.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { getRecipients } from "../../services/channelRouting.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { deliverSession } from "./matchDelivery.js";

type Api = NavaContext["api"];

/**
 * Default-member chat (v1.18.0).
 *
 * When a real user's random search finds nobody, 3 seconds before the 40 s timer ends one of the default
 * ("seed") members is connected instead. For the real user it behaves like any chat: the normal "connected"
 * notice and chat controls, a greeting from the member, the normal "your contact viewed your Nava profile"
 * notice, and 10–20 s later the member ends the chat (normal "ended by your contact" message + main menu).
 * The management channel gets a line when it is over.
 *
 * Money: NOTHING is charged and nothing is refunded — the member has no Relic and the real user pays nothing.
 * Telegram: nothing is ever sent to the member (src/services/seeds/guard.ts swallows it), and the member can
 * never be matched with another member (only a real searcher's queue entry is consumed).
 *
 * Reliability: the scripted part (greeting / notice / end) is described by a durable job (`seed_chat_jobs`,
 * _id = session id). The invocation that matched normally plays it out; if that invocation is cut off, any
 * later webhook request / the user's next message / the cron finalises the chat, so a user can never be stuck
 * in a chat with a silent member.
 */

export const SEED_SEARCH_LEAD_MS = 3000;
export const SEED_GREET_DELAY_MS: [number, number] = [1500, 4000];
export const SEED_NOTICE_GAP_MS: [number, number] = [800, 1800];
export const SEED_END_DELAY_MS: [number, number] = [10_000, 20_000];

/** One-message openers, and two-message openers (the second one follows a few seconds later, like a person typing again). */
export const SINGLE_GREETINGS = ["سلام", "سلام 🙂", "سلام خوبی؟", "سلام عزیز", "های", "سلام، خوبی؟", "درود", "سلام وقت بخیر", "سلاامم", "هی سلام 😊", "سلام چطوری؟", "سلام شب بخیر", "سلام خوش اومدی", "هلو", "سلام، حالت چطوره؟", "سلام ☺️"];
export const DOUBLE_GREETINGS: Array<[string, string]> = [
  ["سلام", "خوبی؟"],
  ["های", "چه خبر؟"],
  ["سلام", "چطوری؟ 🙂"],
  ["درود", "حالت چطوره؟"],
  ["سلام عزیز", "کجایی هستی؟"],
  ["سلام", "اسمت چیه؟"],
  ["هی", "سلام خوبی؟"],
  ["سلام 🙂", "از کجا میای؟"],
];
export const DOUBLE_GREETING_CHANCE = 0.35;
export const SEED_SECOND_GREET_GAP_MS: [number, number] = [1800, 4500];

export function pickGreeting(rnd: () => number = Math.random): string[] {
  if (rnd() < DOUBLE_GREETING_CHANCE) return [...DOUBLE_GREETINGS[Math.floor(rnd() * DOUBLE_GREETINGS.length)]!];
  return [SINGLE_GREETINGS[Math.floor(rnd() * SINGLE_GREETINGS.length)]!];
}

export interface SeedJobDoc {
  _id: string; // session id
  userId: number;
  seedId: number;
  state: "pending" | "done";
  greetAt: Date;
  endAt: Date;
  greeted?: boolean;
  noticed?: boolean;
  announced?: boolean;
  createdAt: Date;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = ([lo, hi]: [number, number], rnd: () => number = Math.random) => Math.round(lo + rnd() * (hi - lo));

async function pairs() {
  return (await getDb()).collection<any>("seed_user_pairs");
}
export async function seedIdsEverMatched(userId: number): Promise<number[]> {
  return (await (await pairs()).find({ userId }).limit(5000).toArray()).map((r: any) => r.seedId as number);
}

async function jobs() {
  return (await getDb()).collection<SeedJobDoc>("seed_chat_jobs");
}

export type SeedMatchResult = { status: "matched"; sessionId: string; seed: UserDoc } | { status: "none" } | { status: "gone" };

export interface SeedMatchOptions {
  createdBefore?: Date;
  rnd?: () => number;
}

/** Atomically turns a queued real searcher into a chat with a default member. Never throws for "normal" outcomes. */
export async function trySeedMatch(api: Api, user: UserDoc, searchType: SearchType, status: { chatId: number; messageId: number } | undefined, opts: SeedMatchOptions = {}): Promise<SeedMatchResult> {
  const rnd = opts.rnd ?? Math.random;
  // a default member is connected to a given real person ONLY ONCE, ever (not just "not within 24 h")
  const exclude = new Set<number>([user._id, ...(await getBlockedCounterparts(user._id)), ...(await seedIdsEverMatched(user._id))]);
  const db = await getDb();
  const queue = db.collection<MatchQueueDoc>("match_queue");
  const usersCol = db.collection<any>("users");
  const sessions = db.collection<ChatSessionDoc>("chat_sessions");

  for (let attempt = 0; attempt < 4; attempt++) {
    const seed = await pickSeedFor(user, searchType, [...exclude]);
    if (!seed) return { status: "none" }; // every suitable member was already used for this person: the normal "nobody found" ending
    const sessionId = newSessionId();
    const now = new Date();
    try {
      await runInTransaction(async (session) => {
        const del = await queue.deleteOne({ _id: user._id, ...(opts.createdBefore ? { createdAt: { $lte: opts.createdBefore } } : {}) } as any, { session });
        if (del.deletedCount !== 1) throw new TxAbort("gone"); // matched with a real person / cancelled meanwhile
        const me = await usersCol.updateOne({ _id: user._id, banned: { $ne: true }, activeChatSessionId: null }, { $set: { activeChatSessionId: sessionId } }, { session });
        if (me.matchedCount !== 1) throw new TxAbort("busy");
        const sd = await usersCol.updateOne({ _id: seed!._id, isSeed: true, seedChatEnabled: true, banned: { $ne: true }, activeChatSessionId: null }, { $set: { activeChatSessionId: sessionId } }, { session });
        if (sd.matchedCount !== 1) throw new TxAbort("seed_taken");
        // the unique pair id is what makes "only once" hold even for two parallel searches of the same person
        try {
          await (await pairs()).insertOne({ _id: `${user._id}:${seed!._id}`, userId: user._id, seedId: seed!._id, at: now }, { session });
        } catch (e: any) {
          if (e?.code === 11000) throw new TxAbort("seed_taken");
          throw e;
        }
        await sessions.insertOne({ _id: sessionId, userA: user._id, userB: seed!._id, active: true, createdAt: now, seedChat: true } as ChatSessionDoc, { session });
        await insertDeliveries(newDeliveryDocs(sessionId, [user._id], "match"), session);
        await voidSearchNotices([user._id], session);
        await (await jobs()).insertOne(
          { _id: sessionId, userId: user._id, seedId: seed!._id, state: "pending", greetAt: new Date(now.getTime() + between(SEED_GREET_DELAY_MS, rnd)), endAt: new Date(now.getTime() + between(SEED_END_DELAY_MS, rnd)), createdAt: now },
          { session },
        );
      });
    } catch (err) {
      if (err instanceof TxAbort) {
        if (err.outcome === "seed_taken") {
          exclude.add(seed._id);
          continue;
        }
        return { status: "gone" }; // "gone" or "busy": the search is over one way or another
      }
      throw err;
    }
    // committed: same clean-up + "connected" notice as a real match
    try {
      if (status) await api.deleteMessage(status.chatId, status.messageId).catch(() => {});
      await deliverSession(api, sessionId, [user._id]);
    } catch (err) {
      console.error("[seed-match] announce failed after commit:", err instanceof Error ? err.name : "unknown");
    }
    return { status: "matched", sessionId, seed };
  }
  return { status: "none" };
}

async function claimStep(sessionId: string, field: "greeted" | "noticed" | "announced"): Promise<SeedJobDoc | null> {
  return (await jobs()).findOneAndUpdate({ _id: sessionId, [field]: { $ne: true } } as any, { $set: { [field]: true } }, { returnDocument: "after" });
}

async function sessionActive(sessionId: string): Promise<ChatSessionDoc | null> {
  const s = await getSession(sessionId);
  return s && s.active ? s : null;
}

async function langOf(userId: number): Promise<Language> {
  const u = await (await getDb()).collection<any>("users").findOne({ _id: userId }, { projection: { languageCode: 1 } });
  return (u?.languageCode as Language) ?? "fa";
}

async function sendGreeting(api: Api, job: SeedJobDoc, rnd: () => number, wait: (ms: number) => Promise<unknown>): Promise<void> {
  const s = await sessionActive(job._id);
  if (!s || !(await claimStep(job._id, "greeted"))) return;
  const parts = pickGreeting(rnd);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      await api.sendChatAction(job.userId, "typing").catch(() => {});
      await wait(between(SEED_SECOND_GREET_GAP_MS, rnd));
      if (!(await sessionActive(job._id))) return; // the person left meanwhile
    }
    await api.sendMessage(job.userId, parts[i]!, { protect_content: s.safeChatEnabled || undefined }).catch(() => {});
    await incrementMessageCount(job._id).catch(() => {});
  }
}

async function sendProfileViewedNotice(api: Api, job: SeedJobDoc): Promise<void> {
  if (!(await sessionActive(job._id)) || !(await claimStep(job._id, "noticed"))) return;
  const lang = await langOf(job.userId);
  const t = dictionary(lang);
  const template = requireLocked(lang, "matching.profileViewNotification", t.matching.profileViewNotification);
  await api.sendMessage(job.userId, template.split("{{NAVA_EMOJI}}").join(textEmoji("NAVA", "🌐")), { parse_mode: "HTML" }).catch(() => {});
}

async function announceToManagement(api: Api, job: SeedJobDoc, session: ChatSessionDoc | null): Promise<void> {
  const db = await getDb();
  const [user, seed] = await Promise.all([db.collection<any>("users").findOne({ _id: job.userId }), db.collection<any>("users").findOne({ _id: job.seedId })]);
  const secs = session?.endedAt ? Math.max(0, Math.round((session.endedAt.getTime() - session.createdAt.getTime()) / 1000)) : null;
  const byUser = session?.endedBy === job.userId;
  const text =
    `🎭 <b>چت با ممبر فرضی تمام شد</b>\n\n` +
    `👤 کاربر: ${escapeHtml(user?.nickname ?? "-")} — <code>${escapeHtml(user?.anonId ?? "-")}</code> (<code>${job.userId}</code>)\n` +
    `🎭 ممبر فرضی: ${escapeHtml(seed?.nickname ?? "-")} — <code>${escapeHtml(seed?.anonId ?? "-")}</code>\n` +
    `⏱ مدت: ${secs ?? "-"} ثانیه • پایان: ${byUser ? "توسط کاربر" : "توسط ممبر فرضی"}`;
  const targets = await getRecipients("seedLog");
  for (const id of targets) await api.sendMessage(id, text, { parse_mode: "HTML" }).catch(() => {});
}

/** The member "presses end chat": the real user sees exactly what they see when a real partner ends the chat. */
async function endByMember(api: Api, job: SeedJobDoc): Promise<void> {
  // nothing was charged, so nothing may be refunded
  const r = await closeSessionAtomic(job._id, job.seedId, () => [], "user_end");
  if (r.status !== "ended") return;
  const db = await getDb();
  const seed = await db.collection<any>("users").findOne({ _id: job.seedId }, { projection: { anonId: 1 } });
  const lang = await langOf(job.userId);
  const t = dictionary(lang);
  const endedText = requireLocked(lang, "matching.chatEndedByPartner", t.matching.chatEndedByPartner)(seed?.anonId ?? "-")
    .split("{{NAVA_EMOJI}}")
    .join(textEmoji("NAVA", "🌐"));
  await api.sendMessage(job.userId, endedText, { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("🚫 گزارش کاربر", `${CHAT_CALLBACKS.report}:${job.seedId}`, "danger")]]) }).catch(() => {});
  const menuText = requireLocked(lang, "onboarding.chooseFromMenu", t.onboarding.chooseFromMenu);
  await api.sendMessage(job.userId, menuText, { reply_markup: buildMainMenuReplyKeyboard(lang) }).catch(() => {});
}

/**
 * Ends the chat if it is still running (the member "ends" it) and, exactly once, tells the management channel
 * and remembers the pair so the same member is not offered to the same person again within 24 h.
 * Safe to call from any number of places concurrently: closing is atomic and the announcement is claimed.
 */
export async function finalizeSeedChat(api: Api, sessionId: string): Promise<boolean> {
  const job = await (await jobs()).findOne({ _id: sessionId });
  if (!job || job.state === "done") return false;
  try {
    if (await sessionActive(sessionId)) await endByMember(api, job);
    if (await claimStep(sessionId, "announced")) {
      const db = await getDb();
      await db.collection<any>("seed_chat_log").updateOne({ _id: `${job.userId}:${job.seedId}` }, { $set: { userId: job.userId, seedId: job.seedId, at: new Date() } }, { upsert: true });
      await announceToManagement(api, job, await getSession(sessionId));
    }
    await (await jobs()).updateOne({ _id: sessionId }, { $set: { state: "done" } });
    return true;
  } catch (err) {
    console.error("[seed-match] finalize failed (will be retried):", err instanceof Error ? err.name : "unknown");
    return false;
  }
}

export interface SeedScriptOptions {
  /** absolute time (ms) after which this invocation stops waiting and leaves the end to the fallback sweep */
  hardStopAt?: number;
  rnd?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Plays greeting → profile-viewed notice → end, in the invocation that created the match. Never throws. */
export async function runSeedScript(api: Api, sessionId: string, opts: SeedScriptOptions = {}): Promise<void> {
  const rnd = opts.rnd ?? Math.random;
  const wait = opts.sleepFn ?? sleep;
  try {
    const job = await (await jobs()).findOne({ _id: sessionId });
    if (!job || job.state === "done") return;
    await wait(Math.max(0, job.greetAt.getTime() - Date.now()));
    await sendGreeting(api, job, rnd, wait);
    await wait(between(SEED_NOTICE_GAP_MS, rnd));
    await sendProfileViewedNotice(api, job);
    // wait for the end time, but notice early if the real user ended the chat themselves
    while (Date.now() < job.endAt.getTime()) {
      if (opts.hardStopAt && Date.now() + 1000 > opts.hardStopAt) return; // cut-off approaching: the sweep ends it later
      if (!(await sessionActive(sessionId))) break;
      await wait(Math.min(1000, Math.max(0, job.endAt.getTime() - Date.now())));
    }
    await finalizeSeedChat(api, sessionId);
  } catch (err) {
    console.error("[seed-match] script failed (sweep will finish it):", err instanceof Error ? err.name : "unknown");
  }
}

/** Called for a user who has an active chat: if it is a default-member chat whose time is up, finish it now. */
export async function settleDueSeedChat(api: Api, sessionId: string): Promise<boolean> {
  const due = await (await jobs()).findOne({ _id: sessionId, state: "pending", endAt: { $lte: new Date() } });
  if (!due) return false;
  return finalizeSeedChat(api, sessionId);
}

/** Opportunistic / cron sweep: finishes default-member chats whose invocation was cut off. Never throws. */
export async function processDueSeedJobs(api: Api, limit = 5, graceMs = 5000): Promise<number> {
  try {
    const due = await (await jobs()).find({ state: "pending", endAt: { $lte: new Date(Date.now() - graceMs) } }).limit(limit).toArray();
    let n = 0;
    for (const j of due) if (await finalizeSeedChat(api, j._id)) n++;
    return n;
  } catch (err) {
    console.error("[seed-match] sweep failed:", err instanceof Error ? err.name : "unknown");
    return 0;
  }
}

/** Hook for the normal "پایان چت" path: the real user ended a default-member chat first. */
export async function onChatEndedBySomeone(api: Api, session: ChatSessionDoc): Promise<void> {
  if (!session.seedChat) return;
  await finalizeSeedChat(api, session._id);
}
