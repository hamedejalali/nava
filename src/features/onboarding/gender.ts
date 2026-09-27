import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { setGenderOnce, type Gender } from "../../db/models/user.js";
import { GENDER_CALLBACK_PREFIX } from "./constants.js";
import { showGuide1AndAge } from "./age.js";
import { recordPrompt, deletePreviousPrompt } from "../../utils/prompts.js";

export function buildGenderKeyboard(lang: Parameters<typeof dictionary>[0]) {
  const t = dictionary(lang);
  const maleText = requireLocked(lang, "onboarding.genderButtonMale", t.onboarding.genderButtonMale);
  const femaleText = requireLocked(lang, "onboarding.genderButtonFemale", t.onboarding.genderButtonFemale);

  // Button text carries NO emoji — the Premium Emoji icon already shows via
  // icon_custom_emoji_id. Putting an emoji in both places was the bug.
  return inlineKeyboard([
    [
      glassButton(maleText, `${GENDER_CALLBACK_PREFIX}male`, "primary", buttonIcon("MALE")),
      glassButton(femaleText, `${GENDER_CALLBACK_PREFIX}female`, "danger", buttonIcon("FEMALE")),
    ],
  ]);
}

/** Edits the current message (the just-answered language screen) into the
 *  gender-selection screen, then records ITS message id so it can be
 *  reliably deleted once gender is actually selected (see
 *  registerGenderHandlers below) — editing in place here is just how this
 *  particular screen appears; it still needs to be cleaned up afterward
 *  like every other onboarding step. */
export async function showGenderStep(ctx: NavaContext, lang: Parameters<typeof dictionary>[0]) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.genderPrompt", t.onboarding.genderPrompt);
  const keyboard = buildGenderKeyboard(lang);

  let messageId: number | undefined;
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
    messageId = ctx.callbackQuery?.message?.message_id;
  } catch {
    // Message could not be edited (e.g. too old, or was already replaced) —
    // fall back to sending a new one so the user is never stuck.
    const sent = await ctx.reply(text, { reply_markup: keyboard });
    messageId = sent.message_id;
  }

  if (messageId) await recordPrompt(ctx, messageId);
}

export function registerGenderHandlers(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${GENDER_CALLBACK_PREFIX}(male|female)$`), async (ctx) => {
    const gender = ctx.match![1] as Gender;
    const lang = ctx.userLang;

    const result = await setGenderOnce(ctx.from!.id, gender);

    if (result.status === "not_found") {
      await ctx.answerCallbackQuery();
      return;
    }

    if (result.status === "already_set") {
      // Stale button from before gender was set, or a duplicate/replayed
      // callback — reject the change, keep the original value, and inform
      // the user via a lightweight alert instead of altering the message.
      const t = dictionary(lang);
      await ctx.answerCallbackQuery({ text: t.errors.genderAlreadySet, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await deletePreviousPrompt(ctx); // removes the gender-question message
    await showGuide1AndAge(ctx, lang);
  });
}
