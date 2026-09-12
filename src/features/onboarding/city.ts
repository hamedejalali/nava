import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassReplyButton, replyKeyboard, styleForIndex, toRows } from "../../ui/keyboard.js";
import { citiesForProvince, isValidCityForProvince } from "../../data/cities.js";
import { setCityOnce, setCityPageIndex } from "../../db/models/user.js";
import { showNicknameStep } from "./nickname.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";

const COLUMNS = 2;
// Some provinces (e.g. Fars, Isfahan) have 100+ cities in the real dataset —
// paginate rather than dumping every button into one Reply Keyboard.
const PAGE_SIZE = 20;
const PREV_LABEL = "◀️ قبلی";
const NEXT_LABEL = "بعدی ▶️";

function buildCityReplyKeyboard(provinceId: string, page: number) {
  const allCities = citiesForProvince(provinceId);
  const totalPages = Math.max(1, Math.ceil(allCities.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const pageCities = allCities.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const cityButtons = pageCities.map((c, i) => glassReplyButton(c.nameFa, styleForIndex(i)));
  const rows = toRows(cityButtons, COLUMNS);

  const navRow = [];
  if (safePage > 0) navRow.push(glassReplyButton(PREV_LABEL, "primary"));
  if (safePage < totalPages - 1) navRow.push(glassReplyButton(NEXT_LABEL, "primary"));
  if (navRow.length > 0) rows.push(navRow);

  return { keyboard: replyKeyboard(rows), safePage, totalPages };
}

export async function showCityStep(ctx: NavaContext, lang: Language, provinceId: string) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.cityPrompt", t.onboarding.cityPrompt);
  const { keyboard } = buildCityReplyKeyboard(provinceId, 0);
  await setCityPageIndex(ctx.from!.id, 0);
  const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  await recordPrompt(ctx, sent.message_id);
}

export function registerCityHandlers(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.onboardingStep !== "CITY_PENDING" || !user.province) {
      return next();
    }

    const text = ctx.message.text.trim();
    const currentPage = user.cityPageIndex ?? 0;

    if (text === NEXT_LABEL || text === PREV_LABEL) {
      const newPage = text === NEXT_LABEL ? currentPage + 1 : currentPage - 1;
      const { keyboard, safePage } = buildCityReplyKeyboard(user.province, newPage);
      await setCityPageIndex(ctx.from!.id, safePage);
      await deletePreviousPrompt(ctx);
      const sent = await ctx.reply("👇", { reply_markup: keyboard });
      await recordPrompt(ctx, sent.message_id);
      return;
    }

    const city = citiesForProvince(user.province).find((c) => c.nameFa === text);
    if (!city || !isValidCityForProvince(city.id, user.province)) {
      await ctx.reply("لطفاً یکی از شهرهای روی کیبورد رو انتخاب کن 👇");
      return;
    }

    const result = await setCityOnce(ctx.from!.id, city.id);
    if (result.status !== "saved") return;

    await deletePreviousPrompt(ctx);
    await showNicknameStep(ctx, ctx.userLang);
  });
}
