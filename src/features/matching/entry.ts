import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { getContent } from "../../db/models/content.js";
import { setPinnedPromoMessageId } from "../../db/models/user.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { MENU_CALLBACKS } from "../menu/mainMenu.js";
import { PARTNER_TYPE_CALLBACKS } from "./constants.js";

// LOCKED default (Feature 05) — must match the admin's "پیام پین" default
// exactly. Duplicated as a plain string here (rather than importing from
// the admin module) to avoid a feature -> admin dependency; the single
// source of truth for the CURRENT value is always MongoDB via getContent.
const DEFAULT_PINNED_PROMO =
  "💰 میخوای از تلگرامت درآمد ملیونی داشته باشی؟ 🤔\n\n" +
  "🧐 شاید باور نکنی ولی اگر بخوای میتونی خیلی راحت از ربات هایپر گپ درآمد داشته باشی!💰\n\n" +
  "❗️ حتما میگی چطوری؟ مگه میشه!🤔\n\n" +
  "🔺 بله که میشه چرا نشه!😍\n\n" +
  "بیا به لینک پایین آموزش ها رو برات گذاشتم! 😍👇\n\n" +
  "📎 https://t.me/pAd/26\n" +
  "📎 https://t.me/Hy\n\n" +
  "👌 بدو بیا که منتظرتما!.. 👆\n\n" +
  "📢 اسکرین درآمد های پرداخت شده➕نمایش کل درآمد کاربران تا این لحظه 🤑👇\n\n" +
  "📎 https://t.me/+CnxZ2FmW64I3MGFk\n" +
  "📎 https://t.me/+CnxZ2FmW64I3MGFk\n\n" +
  "✅ باور نداری بزن رو لینک بالا اسکرین ها رو ببین!👌👆";

function buildPartnerTypeKeyboard(lang: Language) {
  const t = dictionary(lang);
  const label = (path: string, value: string | undefined) => requireLocked(lang, path, value);

  return inlineKeyboard([
    [glassButton(label("matching.luckySearch", t.matching.luckySearch), PARTNER_TYPE_CALLBACKS.lucky, "primary", buttonIcon("DICE"))],
    [
      glassButton(label("matching.maleSearch", t.matching.maleSearch), PARTNER_TYPE_CALLBACKS.male, "primary", buttonIcon("MALE")),
      glassButton(label("matching.femaleSearch", t.matching.femaleSearch), PARTNER_TYPE_CALLBACKS.female, "primary", buttonIcon("FEMALE")),
    ],
    [glassButton(label("matching.nearbySearch", t.matching.nearbySearch), PARTNER_TYPE_CALLBACKS.nearby, "primary", buttonIcon("LOCATION"))],
    [
      glassButton(label("matching.sameAgeSearch", t.matching.sameAgeSearch), PARTNER_TYPE_CALLBACKS.sameAge, "primary", buttonIcon("PEOPLE")),
      glassButton(label("matching.sameProvinceSearch", t.matching.sameProvinceSearch), PARTNER_TYPE_CALLBACKS.sameProvince, "primary", buttonIcon("HOME")),
    ],
  ]);
}

async function sendPinnedPromoOnce(ctx: NavaContext): Promise<void> {
  if (ctx.dbUser?.pinnedPromoMessageId) return; // already sent + pinned for this user

  const text = await getContent("pinnedPromo", DEFAULT_PINNED_PROMO);
  const sent = await ctx.reply(text);

  await setPinnedPromoMessageId(ctx.from!.id, sent.message_id);
  await ctx.pinChatMessage(sent.message_id).catch(() => {
    // Pinning can fail (e.g. missing rights in some chat types) — the
    // promo message itself was still delivered, so this is non-fatal.
  });
}

export async function enterAnonymousMatching(ctx: NavaContext, lang: Language) {
  await sendPinnedPromoOnce(ctx);

  const t = dictionary(lang);
  const promptText = requireLocked(lang, "matching.partnerPrompt", t.matching.partnerPrompt);
  await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: buildPartnerTypeKeyboard(lang) });
}

export function registerMatchingEntry(composer: Composer<NavaContext>) {
  composer.callbackQuery(MENU_CALLBACKS.connectAnonymous, async (ctx) => {
    await ctx.answerCallbackQuery();
    const eligible = await requireChannelMembership(ctx, ctx.userLang);
    if (!eligible) return;
    await enterAnonymousMatching(ctx, ctx.userLang);
  });

  // Partner-type button handlers (real matchmaking) are registered
  // separately in src/features/matching/search.ts.
}
