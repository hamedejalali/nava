import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { resumePendingAnon } from "../anonMessages/index.js";
import { MENU_CALLBACKS, buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { getUser } from "../../db/models/user.js";

export async function showOnboardingCompletion(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);

  const completionText = requireLocked(lang, "onboarding.completionMessage", t.onboarding.completionMessage);
  const guideLabel = requireLocked(lang, "onboarding.guideButton", t.onboarding.guideButton);

  await ctx.reply(completionText, {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard([[glassButton(guideLabel, MENU_CALLBACKS.guide, "primary", buttonIcon("GUIDE"))]]),
  });

  const chooseFromMenuText = requireLocked(lang, "onboarding.chooseFromMenu", t.onboarding.chooseFromMenu);
  await ctx.reply(chooseFromMenuText, { reply_markup: buildMainMenuReplyKeyboard(lang) });

  // v1.29.0: a real profile photo is expected from everybody. One tap opens the «send your photo» step (the same photo is used in
  // the bot profile AND on the Mini App page, so nobody is asked twice).
  const me = ctx.from ? await getUser(ctx.from.id) : null;
  if (me && !me.profilePhotoFileId) {
    await ctx.reply("📸 یه قدم مونده: عکس پروفایلت رو ثبت کن تا پروفایلت کامل بشه.", {
      reply_markup: inlineKeyboard([[glassButton("📸 ثبت عکس پروفایل", "profile:edit:photo", "success")]]),
    });
  }

  // The user may have arrived through someone's anonymous-message link.
  await resumePendingAnon(ctx);
}
