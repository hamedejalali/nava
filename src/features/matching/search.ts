import type { Composer } from "grammy";
import { GrammyError } from "grammy";
import { waitUntil } from "@vercel/functions";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { getUser } from "../../db/models/user.js";
import { getQueueEntry, removeQueueEntry, setQueueStatusMessageId, type SearchType } from "../../db/models/matchQueue.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { attemptMatchOrQueue } from "./engine.js";
import { PARTNER_TYPE_CALLBACKS, SEARCH_CALLBACKS } from "./constants.js";
import { buildChatControlsKeyboard } from "./chatUi.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";

const TYPE_BY_CALLBACK: Record<string, SearchType> = {
  [PARTNER_TYPE_CALLBACKS.lucky]: "lucky",
  [PARTNER_TYPE_CALLBACKS.male]: "male",
  [PARTNER_TYPE_CALLBACKS.female]: "female",
  [PARTNER_TYPE_CALLBACKS.sameAge]: "same_age",
  [PARTNER_TYPE_CALLBACKS.sameProvince]: "same_province",
};

const COUNTDOWN_SECONDS = 40;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function notifyMatch(ctx: NavaContext, telegramId: number, lang: Language, sessionId: string) {
  const t = dictionary(lang);
  const found = requireLocked(lang, "matching.foundPartner", t.matching.foundPartner);
  const warning = requireLocked(lang, "matching.trustWarning", t.matching.trustWarning);

  await ctx.api.sendMessage(telegramId, found);
  // The three chat controls are a persistent reply keyboard now (v1.7.0 —
  // see chatUi.ts), attached to this same message; Telegram keeps it
  // showing at the bottom of the chat from here on, not just on this one
  // message.
  await ctx.api.sendMessage(telegramId, `<blockquote>${warning}</blockquote>`, {
    parse_mode: "HTML",
    reply_markup: buildChatControlsKeyboard(lang, false),
  });
}

/**
 * Runs for up to 40 seconds inside THIS invocation (see vercel.json —
 * api/webhook.ts's maxDuration must be >= ~45s for this to complete
 * without being killed mid-countdown). Every second it re-checks the
 * match_queue entry: if it's gone — because a match was found (the OTHER
 * user's invocation deletes it atomically, see engine.ts) or the user
 * tapped "cancel" (handled below, also deletes it) — this loop simply
 * stops; whichever branch removed the entry already sent the appropriate
 * message. If the entry is still there after 40 seconds, this is the one
 * and only place that declares the search timed out — the Vercel cron job
 * (api/cron/expire-searches.ts) is kept purely as a defensive backstop for
 * the rare case this invocation gets killed before finishing (e.g. a
 * deploy mid-search), not as the primary mechanism anymore.
 */
async function runCountdown(ctx: NavaContext, telegramId: number, chatId: number, statusMessageId: number, lang: Language) {
  for (let elapsed = 1; elapsed <= COUNTDOWN_SECONDS; elapsed++) {
    await sleep(1000);

    // FIXED — this read was NOT wrapped in try/catch. A single transient
    // MongoDB hiccup during any one of these 40 per-second checks used to
    // throw all the way out of this function, uncaught: the countdown
    // message then froze forever at whatever second it reached (exactly
    // the "stuck at 30 seconds" symptom), and — since a genuine processing
    // failure now correctly returns a retryable HTTP status to Telegram
    // (see api/webhook.ts) — Telegram would redeliver the same button tap,
    // which re-entered this handler and created a SECOND, separate
    // countdown message/loop while the first one sat there permanently
    // frozen. A user tapping "لغو جستجو" on that old, orphaned message
    // would silently no-op (its queue entry had already moved on), which
    // is the "cancel button doesn't do anything" symptom. None of this
    // ever risked a double charge (queuing doesn't charge Relic, and the
    // "already in an active chat" guard blocks a retry after a real
    // match), but it did produce confusing, stuck, duplicated UI. A
    // transient failure here now just skips this tick and the countdown
    // keeps going, exactly like a transient Telegram error already did a
    // few lines below.
    let stillQueued;
    try {
      stillQueued = await getQueueEntry(telegramId);
    } catch (err) {
      console.error("[search] getQueueEntry failed mid-countdown (will retry next tick):", err);
      continue;
    }
    if (!stillQueued) return; // matched or cancelled — already handled elsewhere

    try {
      await ctx.api.editMessageReplyMarkup(chatId, statusMessageId, { reply_markup: countdownKeyboard(lang, elapsed) });
    } catch (err) {
      // Only a genuine "message not found / can't be edited" (Telegram 400)
      // means someone else already replaced this message — stop quietly.
      // Anything else (a transient 429 after the bounded retry in
      // src/ui/telegramRetry.ts gave up, a brief network error, ...) must
      // NOT be treated the same way: the search is still valid and queued,
      // so just skip this tick's visual update and keep polling. Silently
      // stopping here used to make searches appear to vanish under load
      // even though the user was still correctly in the queue.
      if (err instanceof GrammyError && err.error_code === 400) return;
    }
  }

  // Full 40s elapsed with no match and no cancellation.
  const stillQueued = await getQueueEntry(telegramId);
  if (!stillQueued) return;

  await removeQueueEntry(telegramId);
  await ctx.api.deleteMessage(chatId, statusMessageId).catch(() => {});
  const t = dictionary(lang);
  await ctx.api
    .sendMessage(telegramId, t.errors.searchTimedOut, { reply_markup: buildMainMenuReplyKeyboard(lang) })
    .catch(() => {});
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

    if ((user.relicBalance ?? 0) < 1) {
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.errors.insufficientBalance);
      return;
    }

    const result = await attemptMatchOrQueue(user, searchType, undefined);

    if (result.status === "matched") {
      await deletePreviousPrompt(ctx); // clears the searcher's own stale status message, if any
      if (result.partnerStatusMessageId) {
        await ctx.api.deleteMessage(result.partnerId, result.partnerStatusMessageId).catch(() => {});
      }

      const partner = await getUser(result.partnerId);
      const partnerLang: Language = partner?.languageCode ?? "fa";

      await notifyMatch(ctx, user._id, ctx.userLang, result.sessionId);
      await notifyMatch(ctx, result.partnerId, partnerLang, result.sessionId);
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
    await setQueueStatusMessageId(user._id, sent.message_id);

    const countdown = runCountdown(ctx, user._id, ctx.chat!.id, sent.message_id, ctx.userLang).catch((err) => {
      console.error("[search] runCountdown crashed (background task):", err);
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

    const entry = await getQueueEntry(user._id);
    if (!entry) return; // already matched or already timed out — stale tap, ignore

    await removeQueueEntry(user._id);
    await ctx.deleteMessage().catch(() => {});

    const t = dictionary(ctx.userLang);
    const cancelledText = requireLocked(ctx.userLang, "matching.searchCancelled", t.matching.searchCancelled);
    await ctx.reply(cancelledText, { reply_markup: buildMainMenuReplyKeyboard(ctx.userLang) });
  });
}
