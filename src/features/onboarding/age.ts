import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard, styleForIndex, toRows } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { markAgeQuestionShown, setAgeOnce } from "../../db/models/user.js";
import { AGE_CALLBACK_PREFIX } from "./constants.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { showProvinceStep } from "./province.js";

const MIN_AGE = 9;
const MAX_AGE = 99;
const COLUMNS = 6;

export function buildAgeKeyboard() {
  const buttons = [];
  for (let age = MIN_AGE; age <= MAX_AGE; age++) {
    buttons.push(glassButton(String(age), `${AGE_CALLBACK_PREFIX}${age}`, styleForIndex(age - MIN_AGE)));
  }
  return inlineKeyboard(toRows(buttons, COLUMNS));
}

/** Feature 03, Step 1 (Guide 1) + Step 2 (age prompt), sent as two separate
 *  NEW messages. Guide 1 must remain visible (never deleted/edited away),
 *  so this intentionally does not edit the previous (gender) message —
 *  that message was already removed/replaced by showGenderStep's edit. */
export async function showGuide1AndAge(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);

  const guide1 = requireLocked(lang, "onboarding.guide1", t.onboarding.guide1);
  await ctx.reply(guide1, { parse_mode: "HTML" });

  const userId = ctx.from!.id;
  await markAgeQuestionShown(userId);

  const agePrompt = requireLocked(lang, "onboarding.agePrompt", t.onboarding.agePrompt);
  const sent = await ctx.reply(agePrompt, { parse_mode: "HTML", reply_markup: buildAgeKeyboard() });
  await recordPrompt(ctx, sent.message_id);
}

async function finalizeAge(ctx: NavaContext, age: number): Promise<"saved" | "wrong_step" | "not_found" | "invalid"> {
  if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) return "invalid";

  const result = await setAgeOnce(ctx.from!.id, age);
  return result.status;
}

export function registerAgeHandlers(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${AGE_CALLBACK_PREFIX}(\\d{1,2})$`), async (ctx) => {
    const age = Number(ctx.match![1]);
    const status = await finalizeAge(ctx, age);
    const t = dictionary(ctx.userLang);

    if (status === "invalid") {
      await ctx.answerCallbackQuery({ text: t.errors.invalidAge, show_alert: true });
      return;
    }
    if (status === "not_found") {
      await ctx.answerCallbackQuery();
      return;
    }
    if (status === "wrong_step") {
      // Stale age keyboard from an earlier/duplicate delivery — the age
      // step has already moved on, so we just acknowledge and do nothing.
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    await deletePreviousPrompt(ctx);
    await showProvinceStep(ctx, ctx.userLang);
  });

  // Manual numeric age entry as free text.
  composer.on("message:text", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.onboardingStep !== "AGE_PENDING") {
      return next();
    }

    const raw = toAsciiDigits(ctx.message.text.trim());
    const t = dictionary(ctx.userLang);

    if (!/^\d{1,2}$/.test(raw)) {
      await ctx.reply(t.errors.invalidAge);
      return;
    }

    const age = Number(raw);
    const status = await finalizeAge(ctx, age);

    if (status === "invalid") {
      await ctx.reply(t.errors.invalidAge);
      return;
    }
    if (status === "wrong_step" || status === "not_found") {
      return; // already progressed elsewhere / nothing to do
    }

    await deletePreviousPrompt(ctx);
    await showProvinceStep(ctx, ctx.userLang);
  });
}
