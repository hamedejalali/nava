import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassReplyButton, replyKeyboard, styleForIndex, toRows } from "../../ui/keyboard.js";
import { PROVINCES, isValidProvince } from "../../data/provinces.js";
import { setProvinceOnce } from "../../db/models/user.js";
import { showCityStep } from "./city.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";

const COLUMNS = 2;

export function buildProvinceReplyKeyboard() {
  const buttons = PROVINCES.map((p, index) => glassReplyButton(p.nameFa, styleForIndex(index)));
  return replyKeyboard(toRows(buttons, COLUMNS));
}

export async function showProvinceStep(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.provincePrompt", t.onboarding.provincePrompt);
  const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: buildProvinceReplyKeyboard() });
  await recordPrompt(ctx, sent.message_id);
}

export function registerProvinceHandlers(composer: Composer<NavaContext>) {
  // Reply Keyboard tap (or manually typed province name) arrives as plain text.
  composer.on("message:text", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.onboardingStep !== "AGE_DONE") {
      return next();
    }

    const text = ctx.message.text.trim();
    const province = PROVINCES.find((p) => p.nameFa === text);

    if (!province || !isValidProvince(province.id)) {
      await ctx.reply("لطفاً یکی از استان‌های روی کیبورد رو انتخاب کن 👇");
      return;
    }

    const result = await setProvinceOnce(ctx.from!.id, province.id);
    if (result.status !== "saved") return; // stale/duplicate, already progressed

    await deletePreviousPrompt(ctx);
    await showCityStep(ctx, ctx.userLang, province.id);
  });
}
