import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard, styleForIndex, toRows } from "../../ui/keyboard.js";
import { PROVINCES, isValidProvince } from "../../data/provinces.js";
import { setProvinceOnce } from "../../db/models/user.js";
import { PROVINCE_CALLBACK_PREFIX } from "./constants.js";
import { showCityStep } from "./city.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";

const COLUMNS = 2; // "two rows of buttons underneath each other" grid, mobile-friendly

export function buildProvinceKeyboard() {
  const buttons = PROVINCES.map((p, index) => glassButton(p.nameFa, `${PROVINCE_CALLBACK_PREFIX}${index}`, styleForIndex(index)));
  return inlineKeyboard(toRows(buttons, COLUMNS));
}

export async function showProvinceStep(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.provincePrompt", t.onboarding.provincePrompt);
  const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: buildProvinceKeyboard() });
  await recordPrompt(ctx, sent.message_id);
}

export function registerProvinceHandlers(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${PROVINCE_CALLBACK_PREFIX}(\\d{1,2})$`), async (ctx) => {
    const index = Number(ctx.match![1]);
    const province = PROVINCES[index];

    if (!province || !isValidProvince(province.id)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result = await setProvinceOnce(ctx.from!.id, province.id);
    await ctx.answerCallbackQuery();

    if (result.status !== "saved") {
      // wrong_step: stale keyboard from an earlier/duplicate delivery —
      // the user already moved past this step, nothing to do.
      return;
    }

    await deletePreviousPrompt(ctx);
    await showCityStep(ctx, ctx.userLang, province.id);
  });
}
