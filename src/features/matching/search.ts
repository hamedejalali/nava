import type { Composer } from "grammy";
import { hasUnlimitedXp } from "../../db/models/relic.js";
import { GrammyError } from "grammy";
import { waitUntil } from "@vercel/functions";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { claimQueueEntry, queueEntryExists, SEARCH_TIMEOUT_MS, setQueueStatusMessageId, type SearchType } from "../../db/models/matchQueue.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { attemptMatchOrQueue, rescanQueued, type MatchAttemptResult } from "./engine.js";
import { PARTNER_TYPE_CALLBACKS, SEARCH_CALLBACKS } from "./constants.js";
import { CHAT_REQUEST_ACCEPTED_TEXT, classifySendError, deliverSession } from "./matchDelivery.js";
import { claimSearchNotice } from "../../db/models/searchNotice.js";
import { sendTimeoutNotice, settleNotice } from "./searchNotices.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { runSeedScript, SEED_SEARCH_LEAD_MS, trySeedMatch } from "./seedMatch.js";

const TYPE_BY_CALLBACK: Record<string, SearchType> = {
  [PARTNER_TYPE_CALLBACKS.lucky]: "lucky",
  [PARTNER_TYPE_CALLBACKS.male]: "male",
  [PARTNER_TYPE_CALLBACKS.female]: "female",
  [PARTNER_TYPE_CALLBACKS.sameAge]: "same_age",
  [PARTNER_TYPE_CALLBACKS.sameProvince]: "same_province",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The person can not be reached at all (blocked the bot / account gone). */
function isUnreachableError(err: unknown): boolean {
  return classifySendError(err) === "unreachable";
}
/** A Telegram error that retrying the same request can never fix. */
function isPermanentSendError(err: unknown): boolean {
  return classifySendError(err) !== "transient";
}

function labelFor(lang: Language, searchType: SearchType): string {
  const t = dictionary(lang);
  const map: Record<SearchType, [string, string | undefined]> = {
    lucky: ["matching.luckySearch", t.matching.luckySearch],
    male: ["matching.maleSearch", t.matching.maleSearch],
    female: ["matching.femaleSearch", t.matching.femaleSearch],
    same_age: ["matching.sameAgeSearch", t.matching.sameAgeSearch],
    same_province: ["matching.sameProvinceSearch", t.matching.sameProvinceSearch],
  };
  const [path, value] = map[searchType];
  return requireLocked(lang, path, value);
}

function countdownKeyboard(lang: Language, elapsedSeconds: number) {
  const t = dictionary(lang);
  const cancelLabel = requireLocked(lang, "matching.cancelSearchButton", t.matching.cancelSearchButton);
  return inlineKeyboard([
    [glassButton(`⏳ ${elapsedSeconds}`, SEARCH_CALLBACKS.noop, "primary")],
    [glassButton(cancelLabel, SEARCH_CALLBACKS.cancel, "danger")],
  ]);
}

export { CHAT_REQUEST_ACCEPTED_TEXT };
export { isUnreachableError, isPermanentSendError };

/** Shared by the search handler and the countdown: cleans the status messages and delivers the "connected"
 *  notice to both users.
 *
 *  The match is ALREADY committed (both charged, session created, and one durable delivery record per
 *  person written in the same transaction) when this runs, so it must never throw. Each person is handled
 *  independently and in parallel (see matchDelivery.ts): a transient failure for one is retried later from
 *  the durable record (webhook traffic / cron) without touching the chat or the money; a person who can never
 *  be reached (blocked the bot) gets the match undone ATOMICALLY with both Relic refunded. */
async function announceMatch(api: NavaContext["api"], user: { _id: number }, _lang: Language, result: Extract<MatchAttemptResult, { status: "matched" }>, ownStatus?: { chatId: number; messageId: number }) {
  try {
    if (ownStatus) await api.deleteMessage(ownStatus.chatId, ownStatus.messageId).catch(() => {});
    if (result.partnerStatusMessageId) await api.deleteMessage(result.partnerId, result.partnerStatusMessageId).catch(() => {});
    await deliverSession(api, result.sessionId, [user._id, result.partnerId]);
  } catch (err) {
    console.error("[match] announce failed after commit:", err instanceof Error ? err.name : "unknown");
  }
}

export interface CountdownOptions {
  totalMs?: number; // default SEARCH_TIMEOUT_MS
  tickMs?: number; // default 2000
  /** never connect a default (seed) member (tests / emergency switch) */
  noSeed?: boolean;
}

/** A default-member chat is played out inside this invocation, but Vercel stops a function at ~60 s: after this
 *  much time from the countdown's start the invocation stops waiting and the sweep ends the chat later. */
const SEED_SCRIPT_BUDGET_MS = 55_000;

/**
 * Search countdown (rewritten v1.12.0). It is driven by the WALL CLOCK, not by "N sleeps of 1 s":
 * the old loop did sleep(1 s) + a Mongo read + a Telegram edit per tick (~1.4 s in practice), so 40 ticks
 * took ~56 s and Vercel killed the function at 45 s (the "stuck at 30 seconds" symptom). It also checked
 * the queue entry with an `expiresAt > now` filter, so right at the deadline the entry looked "gone" and
 * the timeout message was silently skipped. Now:
 *  - the deadline is absolute (start + 40 s) and the function always finishes right after it;
 *  - the displayed number is the real elapsed time, refreshed every 2 s (half the Telegram edits);
 *  - every tick also re-scans for a partner, so two people who searched at the same moment still meet;
 *  - the final timeout is decided by an ATOMIC claim of the queue entry, so timeout / cancel / match can
 *    never both fire.
 */
export async function runCountdown(
  api: NavaContext["api"],
  user: { _id: number; gender?: any; age?: any; province?: any } & Record<string, any>,
  chatId: number,
  statusMessageId: number,
  lang: Language,
  searchType: SearchType,
  opts: CountdownOptions = {},
) {
  const totalMs = opts.totalMs ?? SEARCH_TIMEOUT_MS;
  const tickMs = opts.tickMs ?? 2000;
  const startedAt = Date.now();
  const deadline = startedAt + totalMs;
  let lastShown = -1;
  // v1.18.0: 3 s before the end, if still nobody was found, a default member may be connected (see seedMatch.ts)
  const seedAt = deadline - SEED_SEARCH_LEAD_MS;
  let seedTried = !!opts.noSeed;

  while (Date.now() < deadline) {
    let wake = Math.min(tickMs, Math.max(0, deadline - Date.now()));
    if (!seedTried) wake = Math.min(wake, Math.max(0, seedAt - Date.now()));
    await sleep(wake);
    if (Date.now() >= deadline) break;

    try {
      if (!(await queueEntryExists(user._id, { createdBefore: new Date(startedAt) }))) return; // matched or cancelled — whoever removed it already answered
    } catch (err) {
      console.error("[search] queue check failed mid-countdown (will retry next tick):", err instanceof Error ? err.name : "unknown");
      continue;
    }

    try {
      const r = await rescanQueued(user as any, searchType);
      if (r.status === "matched") {
        await announceMatch(api, user, lang, r, { chatId, messageId: statusMessageId });
        return;
      }
      if (r.status === "matched_elsewhere" || r.status === "busy") return;
    } catch (err) {
      console.error("[search] rescan failed (will retry next tick):", err instanceof Error ? err.name : "unknown");
    }

    if (!seedTried && Date.now() >= seedAt) {
      seedTried = true;
      try {
        const sm = await trySeedMatch(api, user as any, searchType, { chatId, messageId: statusMessageId }, { createdBefore: new Date(startedAt) });
        if (sm.status === "matched") {
          await runSeedScript(api, sm.sessionId, { hardStopAt: startedAt + SEED_SCRIPT_BUDGET_MS });
          return;
        }
        if (sm.status === "gone") return; // matched with a real person / cancelled meanwhile: whoever did it answered
      } catch (err) {
        console.error("[search] default-member match failed (normal timeout follows):", err instanceof Error ? err.name : "unknown");
      }
    }

    const elapsed = Math.min(Math.round((Date.now() - startedAt) / 1000), Math.round(totalMs / 1000));
    if (elapsed === lastShown) continue;
    lastShown = elapsed;
    try {
      await api.editMessageReplyMarkup(chatId, statusMessageId, { reply_markup: countdownKeyboard(lang, elapsed) });
    } catch (err) {
      // 400 = the message was replaced/deleted by someone else: stop quietly. Anything else (429, network)
      // only skips this visual update — the search is still valid.
      if (err instanceof GrammyError && err.error_code === 400 && !/not modified/i.test(err.description)) return;
    }
  }

  // Deadline reached: exactly one party gets to remove the entry; only that party declares the timeout.
  let claimed;
  try {
    claimed = await claimQueueEntry(user._id, { createdBefore: new Date(startedAt), forTimeout: true });
  } catch (err) {
    console.error("[search] timeout claim failed (daily cron will clean up):", err instanceof Error ? err.name : "unknown");
    return;
  }
  if (!claimed) return;
  await api.deleteMessage(chatId, statusMessageId).catch(() => {});
  // The durable notice record decides who delivers: if the recovery pass already took it, we stay silent.
  let notice: Awaited<ReturnType<typeof claimSearchNotice>> = { status: "none" };
  try {
    notice = await claimSearchNotice(user._id, claimed.createdAt);
  } catch (err) {
    console.error("[search] could not claim timeout notice (sending without it):", err instanceof Error ? err.name : "unknown");
  }
  if (notice.status === "taken") return;
  const res = await sendTimeoutNotice(api, user._id, lang);
  if (notice.status === "claimed") await settleNotice(notice.notice, res).catch(() => {});
}

export function registerSearch(composer: Composer<NavaContext>) {
  composer.callbackQuery(Object.values(PARTNER_TYPE_CALLBACKS), async (ctx) => {
    const user = ctx.dbUser;
    if (!user) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (user.activeChatSessionId) {
      const t = dictionary(ctx.userLang);
      await ctx.answerCallbackQuery({ text: t.errors.alreadyInChat, show_alert: true });
      return;
    }

    // Continuous force-join re-check: a user may have left a required
    // channel since onboarding or since their last search — verify again,
    // live, before allowing this restricted action (never trust a cached
    // boolean).
    await ctx.answerCallbackQuery();
    const eligible = await requireChannelMembership(ctx, ctx.userLang);
    if (!eligible) return;

    if (ctx.callbackQuery.data === PARTNER_TYPE_CALLBACKS.nearby) {
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.errors.nearbyUnavailable);
      return;
    }

    const searchType = TYPE_BY_CALLBACK[ctx.callbackQuery.data!];
    if (!searchType) return;

    if (!hasUnlimitedXp(user._id) && (user.relicBalance ?? 0) < 1) {
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.errors.insufficientBalance);
      return;
    }

    const result = await attemptMatchOrQueue(user, searchType, undefined);

    if (result.status === "matched") {
      await deletePreviousPrompt(ctx); // clears the searcher's own stale status message, if any
      await announceMatch(ctx.api, user, ctx.userLang, result);
      return;
    }
    if (result.status === "busy") {
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.errors.alreadyInChat);
      return;
    }
    if (result.status === "matched_elsewhere") {
      // The other searcher's invocation created the session and notifies both of us.
      await deletePreviousPrompt(ctx);
      return;
    }

    // Queued — show the search-status message with a live countdown +
    // cancel button.
    //
    // FIXED (v1.7.0) — CRITICAL: this used to `await runCountdown(...)`
    // right here, which meant `bot.handleUpdate()` — and therefore this
    // whole webhook HTTP request — did not finish until the ENTIRE
    // 40-second countdown was over. Telegram only keeps a limited number
    // of webhook deliveries "in flight" to one bot at a time
    // (`max_connections`, defaulting to 40 when not set explicitly — see
    // scripts/set-webhook.ts); every second that one search held this
    // slot open was a second that slot could not be used for anyone
    // else's tap, message, or the "لغو جستجو" button itself, which
    // explains it looking completely unresponsive for other users while a
    // search was running, and the cancel button doing nothing (its own
    // update was simply queued behind the still-open one). It also meant
    // Vercel billed and reserved a full function instance for 40 seconds
    // per search, for a page that Telegram was just waiting on. `waitUntil`
    // (from `@vercel/functions`, Vercel's own supported mechanism for
    // exactly this) lets the HTTP response go back to Telegram immediately
    // once the status message is sent, while `runCountdown` keeps running
    // in the background for the rest of its normal lifetime — the visible
    // countdown/timeout behavior for the user is completely unchanged.
    await deletePreviousPrompt(ctx);
    const label = labelFor(ctx.userLang, searchType);
    const t = dictionary(ctx.userLang);
    const statusText = requireLocked(ctx.userLang, "matching.searchingStatus", t.matching.searchingStatus)(label);
    const sent = await ctx.reply(statusText, { reply_markup: countdownKeyboard(ctx.userLang, 0) });
    await recordPrompt(ctx, sent.message_id);
    const stillQueued = await setQueueStatusMessageId(user._id, sent.message_id);
    if (!stillQueued) {
      // Matched (or cancelled) in the instant between queuing and sending the status message:
      // that matcher could not know this message id, so remove our own stale "searching" message.
      await ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => {});
      return;
    }

    const countdown = runCountdown(ctx.api, user, ctx.chat!.id, sent.message_id, ctx.userLang, searchType).catch((err) => {
      console.error("[search] runCountdown crashed (background task):", err instanceof Error ? err.name : "unknown");
    });
    // Outside a real Vercel request (local `node`/tests, another host)
    // `waitUntil` is simply a no-op — the promise above still runs to
    // completion on Node's own event loop regardless, it just isn't
    // specially protected against the process being frozen right after
    // the response is sent, which only Vercel's runtime ever does.
    waitUntil(countdown);
  });

  composer.callbackQuery(SEARCH_CALLBACKS.cancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = ctx.dbUser;
    if (!user) return;

    // Atomic: if a match (or the timeout) removed the entry first, this tap is stale and does nothing.
    const mine = await claimQueueEntry(user._id);
    if (!mine) {
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    await ctx.deleteMessage().catch(() => {});

    const t = dictionary(ctx.userLang);
    const cancelledText = requireLocked(ctx.userLang, "matching.searchCancelled", t.matching.searchCancelled);
    await ctx.reply(cancelledText, { reply_markup: buildMainMenuReplyKeyboard(ctx.userLang) });
  });
}
