import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard, styleForIndex, toRows } from "../../ui/keyboard.js";
import { citiesForProvince, isValidCityForProvince } from "../../data/cities.js";
import { setCityOnce } from "../../db/models/user.js";
import { CITY_CALLBACK_PREFIX } from "./constants.js";
import { showNicknameStep } from "./nickname.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";

const COLUMNS = 2;
// Some provinces (e.g. Fars, Isfahan) have 100+ cities in the real dataset —
// paginate rather than dumping every button into one keyboard.
const PAGE_SIZE = 20;
const CITY_PAGE_CALLBACK_PREFIX = "citypage:";

function buildCityKeyboard(provinceId: string, page: number) {
  const allCities = citiesForProvince(provinceId);
  const totalPages = Math.max(1, Math.ceil(allCities.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const pageCities = allCities.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  // Callback index is the GLOBAL index into citiesForProvince(), not the
  // page-local index, so selection validation stays simple and unambiguous.
  const globalOffset = safePage * PAGE_SIZE;

  const cityButtons = pageCities.map((c, i) =>
    glassButton(c.nameFa, `${CITY_CALLBACK_PREFIX}${globalOffset + i}`, styleForIndex(globalOffset + i))
  );
  const rows = toRows(cityButtons, COLUMNS);

  const navRow = [];
  if (safePage > 0) navRow.push(glassButton("◀️ قبلی", `${CITY_PAGE_CALLBACK_PREFIX}${safePage - 1}`, "primary"));
  if (safePage < totalPages - 1) navRow.push(glassButton("بعدی ▶️", `${CITY_PAGE_CALLBACK_PREFIX}${safePage + 1}`, "primary"));
  if (navRow.length > 0) rows.push(navRow);

  return inlineKeyboard(rows);
}

export async function showCityStep(ctx: NavaContext, lang: Language, provinceId: string) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.cityPrompt", t.onboarding.cityPrompt);
  const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: buildCityKeyboard(provinceId, 0) });
  await recordPrompt(ctx, sent.message_id);
}

export function registerCityHandlers(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${CITY_PAGE_CALLBACK_PREFIX}(\\d{1,3})$`), async (ctx) => {
    const user = ctx.dbUser;
    if (!user?.province) {
      await ctx.answerCallbackQuery();
      return;
    }
    const page = Number(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: buildCityKeyboard(user.province, page) }).catch(() => {});
  });

  composer.callbackQuery(new RegExp(`^${CITY_CALLBACK_PREFIX}(\\d{1,3})$`), async (ctx) => {
    const user = ctx.dbUser;
    if (!user?.province) {
      // No province on record (shouldn't happen at this step) — bail safely.
      await ctx.answerCallbackQuery();
      return;
    }

    const index = Number(ctx.match![1]);
    const city = citiesForProvince(user.province)[index];

    if (!city || !isValidCityForProvince(city.id, user.province)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result = await setCityOnce(ctx.from!.id, city.id);
    await ctx.answerCallbackQuery();

    if (result.status !== "saved") return;

    await deletePreviousPrompt(ctx);
    await showNicknameStep(ctx, ctx.userLang);
  });
}
