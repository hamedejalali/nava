import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { getUser } from "../../db/models/user.js";
import { setQueueStatusMessageId, type SearchType } from "../../db/models/matchQueue.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { attemptMatchOrQueue } from "./engine.js";
import { PARTNER_TYPE_CALLBACKS } from "./constants.js";
import { buildChatControlsKeyboard } from "./chatUi.js";
import { requireChannelMembership } from "../forcejoin/guard.js";

const TYPE_BY_CALLBACK: Record<string, SearchType> = {
  [PARTNER_TYPE_CALLBACKS.lucky]: "lucky",
  [PARTNER_TYPE_CALLBACKS.male]: "male",
  [PARTNER_TYPE_CALLBACKS.female]: "female",
  [PARTNER_TYPE_CALLBACKS.sameAge]: "same_age",
  [PARTNER_TYPE_CALLBACKS.sameProvince]: "same_province",
};

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

    // Queued — show the search-status message.
    await deletePreviousPrompt(ctx);
    const label = labelFor(ctx.userLang, searchType);
    const t = dictionary(ctx.userLang);
    const statusText = requireLocked(ctx.userLang, "matching.searchingStatus", t.matching.searchingStatus)(label);
    const sent = await ctx.reply(statusText);
    await recordPrompt(ctx, sent.message_id);
    await setQueueStatusMessageId(user._id, sent.message_id);
  });
}
