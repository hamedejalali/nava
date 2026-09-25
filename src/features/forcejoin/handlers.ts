import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked } from "../../i18n/index.js";
import { setChannelsExempt } from "../../db/models/user.js";
import { listActiveChannels } from "../../db/models/channel.js";
import { isMemberOfAll } from "./guard.js";
import { FORCE_JOIN_VERIFY_CALLBACK } from "./constants.js";
import { resumePendingAnon } from "../anonMessages/index.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";

export function registerForceJoin(composer: Composer<NavaContext>) {
  composer.callbackQuery(FORCE_JOIN_VERIFY_CALLBACK, async (ctx) => {
    const lang = ctx.userLang;
    const channels = await listActiveChannels();

    if (channels.length > 0) {
      const ok = await isMemberOfAll(ctx, channels);
      if (!ok) {
        await ctx.answerCallbackQuery({ text: "هنوز عضو همه‌ی کانال‌ها نشدی.", show_alert: true });
        // Screen stays visible with membership still marked incomplete —
        // no re-render needed since the message content is unchanged.
        return;
      }
    }

    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});

    const t = dictionary(lang);
    const verifiedText = requireLocked(lang, "forceJoin.verifiedMessage", t.forceJoin.verifiedMessage);
    await ctx.reply(verifiedText, { parse_mode: "HTML", reply_markup: buildMainMenuReplyKeyboard(lang) });

    // Continue an anonymous-message link the user opened before joining.
    await resumePendingAnon(ctx);
  });

  composer.command("Exempt", async (ctx) => {
    if (!ctx.from) return;
    await setChannelsExempt(ctx.from.id);
    const t = dictionary(ctx.userLang);
    await ctx.reply(t.errors.exemptConfirmation);
  });
}
