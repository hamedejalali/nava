import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import type { Language } from "../../db/models/user.js";
import { dictionary } from "../../i18n/index.js";
import { fa } from "../../i18n/locales/fa.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { getOrCreateUser, setUserLanguage } from "../../db/models/user.js";
import { LANGUAGE_CALLBACK_PREFIX, LANGUAGE_EMOJI_ENV_KEY } from "./constants.js";
import { showGenderStep } from "./gender.js";
import { showGuide1AndAge } from "./age.js";
import { showProvinceStep } from "./province.js";
import { showCityStep } from "./city.js";
import { showNicknameStep } from "./nickname.js";
import { buildMainMenuKeyboard } from "../menu/mainMenu.js";
import { requireLocked } from "../../i18n/index.js";
import { isOwner, isAdmin } from "../admin/constants.js";
import { sendOwnerAdminWelcome } from "../admin/ownerBypass.js";

const LANGUAGES: Language[] = ["fa", "en", "ar"];

export function buildLanguageKeyboard() {
  const t = dictionary("fa"); // languageButtons labels are identical across
  // locale files by design (they are the language names themselves), so any
  // locale's copy works; "fa" is used as the canonical source.

  const buttons = LANGUAGES.map((lang, index) => {
    const style = (["primary", "success", "danger"] as const)[index]!;
    const icon = buttonIcon(LANGUAGE_EMOJI_ENV_KEY[lang]);
    return glassButton(t.languageButtons[lang], `${LANGUAGE_CALLBACK_PREFIX}${lang}`, style, icon);
  });

  return inlineKeyboard([buttons]);
}

/** Sends the Feature 01 welcome screen. This scripted welcome text is
 *  always shown in Persian exactly as supplied by the project owner —
 *  the user hasn't chosen a language yet at this point. */
export async function sendWelcome(ctx: NavaContext, firstName: string) {
  const text = fa.onboarding.welcome!(firstName);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: buildLanguageKeyboard() });
}

export function registerLanguageHandlers(composer: Composer<NavaContext>) {
  composer.command("start", async (ctx) => {
    if (!ctx.from) return;

    const user = await getOrCreateUser({
      telegramId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
    });

    // Owner/admin accounts NEVER go through gender/age/province/city/
    // nickname onboarding — straight to the admin panel every time.
    if (isOwner(ctx) || isAdmin(ctx)) {
      await sendOwnerAdminWelcome(ctx, user, ctx.from.first_name);
      return;
    }

    if (user.onboardingStep === "LANGUAGE_PENDING") {
      await sendWelcome(ctx, ctx.from.first_name);
      return;
    }

    await resumeAt(ctx, user.onboardingStep, user.languageCode ?? "fa", user.province);
  });

  composer.callbackQuery(new RegExp(`^${LANGUAGE_CALLBACK_PREFIX}(fa|en|ar)$`), async (ctx) => {
    const lang = ctx.match![1] as Language;

    await setUserLanguage(ctx.from!.id, lang);
    await ctx.answerCallbackQuery();

    ctx.userLang = lang;
    await showGenderStep(ctx, lang);
  });
}

/** /start sent by a returning user who is mid-onboarding (or fully done)
 *  resumes exactly where they left off instead of restarting the flow —
 *  per Feature 01 ("do not ask for language again every time"), extended
 *  to every onboarding step for consistency. */
async function resumeAt(ctx: NavaContext, step: string, lang: Language, province?: string) {
  switch (step) {
    case "GENDER_PENDING":
      return showGenderStep(ctx, lang);
    case "GUIDE1_SHOWN":
      return showGuide1AndAge(ctx, lang);
    case "AGE_PENDING":
      return showGuide1AndAge(ctx, lang); // idempotent re-send of the age step
    case "AGE_DONE":
      return showProvinceStep(ctx, lang);
    case "CITY_PENDING":
      return province ? showCityStep(ctx, lang, province) : showProvinceStep(ctx, lang);
    case "NICKNAME_PENDING":
      return showNicknameStep(ctx, lang);
    case "COMPLETED":
    default: {
      const t = dictionary(lang);
      const text = requireLocked(lang, "onboarding.chooseFromMenu", t.onboarding.chooseFromMenu);
      await ctx.reply(text, { reply_markup: buildMainMenuKeyboard(lang) });
    }
  }
}
