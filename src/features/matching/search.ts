import type { Composer } from "grammy";
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

async function notifyMatch(ctx: NavaContext, telegramId: number, lang: Language) {
  const t = dictionary(lang);
  const found = requireLocked(lang, "matching.foundPartner", t.matching.foundPartner);
  const warning = requireLocked(lang, "matching.trustWarning", t.matching.trustWarning);

  await ctx.api.sendMessage(telegramId, found);
  await ctx.api.sendMessage(telegramId, `<blockquote>${warning}</blockquote>`, {
    parse_mode: "HTML",
    reply_markup: buildChatControlsKeyboard(lang),
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

    const stillQueued = await getQueueEntry(telegramId);
    if (!stillQueued) return; // matched or cancelled — already handled elsewhere

    try {
      await ctx.api.editMessageReplyMarkup(chatId, statusMessageId, { reply_markup: countdownKeyboard(lang, elapsed) });
    } catch {
      return; // message was deleted/edited by another path in the meantime — stop quietly
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

      await notifyMatch(ctx, user._id, ctx.userLang);
      await notifyMatch(ctx, result.partnerId, partnerLang);
      return;
    }

    // Queued — show the search-status message with a live countdown +
    // cancel button, then hold this invocation open to animate it (see
    // runCountdown's doc comment for why this replaces the old
    // cron-only timeout).
    await deletePreviousPrompt(ctx);
    const label = labelFor(ctx.userLang, searchType);
    const t = dictionary(ctx.userLang);
    const statusText = requireLocked(ctx.userLang, "matching.searchingStatus", t.matching.searchingStatus)(label);
    const sent = await ctx.reply(statusText, { reply_markup: countdownKeyboard(ctx.userLang, 0) });
    await recordPrompt(ctx, sent.message_id);
    await setQueueStatusMessageId(user._id, sent.message_id);

    await runCountdown(ctx, user._id, ctx.chat!.id, sent.message_id, ctx.userLang);
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
