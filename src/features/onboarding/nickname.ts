import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { setNicknameOnce, getUserByAnonId } from "../../db/models/user.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { showOnboardingCompletion } from "./completion.js";
import { grantReferralRewardOnce, grantProfileCompletionRewardOnce } from "../../db/models/relic.js";
import { textEmoji } from "../../config/emojis.js";

const PERSIAN_NICKNAME_PATTERN = /^[آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی\u200C ]+$/;
const MAX_NICKNAME_LENGTH = 32;

export function isValidPersianNickname(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NICKNAME_LENGTH) return false;
  return PERSIAN_NICKNAME_PATTERN.test(trimmed);
}

// v1.30.0: real users' names are English only (Latin letters + single spaces); Persian stays valid for seeds.
const ENGLISH_NICKNAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+)*$/;

export function isValidEnglishNickname(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NICKNAME_LENGTH) return false;
  return ENGLISH_NICKNAME_PATTERN.test(trimmed);
}

/** true when a stored name is not acceptable under the English rule (legacy Persian names). */
export function nicknameNeedsEnglish(nick: unknown): boolean {
  return typeof nick !== "string" || !isValidEnglishNickname(nick);
}

export async function showNicknameStep(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.nicknamePrompt", t.onboarding.nicknamePrompt);
  const sent = await ctx.reply(text, { parse_mode: "HTML" });
  await recordPrompt(ctx, sent.message_id);
}

/** Saves the name on the LAST onboarding step (NICKNAME_PENDING → COMPLETED), pays the two one-time Relic bonuses and shows the ending.
 *  Shared by the typed-name handler and by flows that already know a valid English name (v1.30.0 invite flow). */
export async function completeOnboardingWithNickname(ctx: NavaContext, nickname: string): Promise<void> {
  const result = await setNicknameOnce(ctx.from!.id, nickname);
  if (result.status !== "saved") return; // stale/duplicate — already progressed

  // Onboarding just fully completed — pay out the two one-time Relic
  // bonuses (each independently idempotent, so this is safe even if
  // this handler somehow re-fires for the same user).
  await grantProfileCompletionRewardOnce(ctx.from!.id);
  if (result.user.referredBy) {
    const referrer = await getUserByAnonId(result.user.referredBy);
    if (referrer) {
      const rewarded = await grantReferralRewardOnce(referrer._id, ctx.from!.id);
      if (rewarded) {
        const relicEmoji = textEmoji("RELIC", "💰");
        await ctx.api
          .sendMessage(
            referrer._id,
            `🎉 یکی از دوستانت با لینک دعوتت به مویا پیوست و پروفایلش رو کامل کرد!\n${relicEmoji} ۲۰ ژتون به حساب شما اضافه شد.`
          )
          .catch(() => {});
      }
    }
  }

  await deletePreviousPrompt(ctx);
  await showOnboardingCompletion(ctx, ctx.userLang);
}

export function registerNicknameHandlers(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.onboardingStep !== "NICKNAME_PENDING") {
      return next();
    }

    const t = dictionary(ctx.userLang);
    const raw = ctx.message.text;

    if (!isValidEnglishNickname(raw)) {
      const errorText = requireLocked(ctx.userLang, "onboarding.nicknameInvalid", t.onboarding.nicknameInvalid);
      const sentError = await ctx.reply(errorText);
      // The error message itself becomes the new "previous message to
      // delete" once a valid nickname is eventually sent, per spec ("delete
      // the previous nickname request/error message where appropriate").
      await recordPrompt(ctx, sentError.message_id);
      return;
    }

    await completeOnboardingWithNickname(ctx, raw.trim());
  });
}
