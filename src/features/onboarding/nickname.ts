import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { setNicknameOnce } from "../../db/models/user.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { showOnboardingCompletion } from "./completion.js";

const PERSIAN_NICKNAME_PATTERN = /^[آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی\u200C ]+$/;
const MAX_NICKNAME_LENGTH = 32;

export function isValidPersianNickname(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NICKNAME_LENGTH) return false;
  return PERSIAN_NICKNAME_PATTERN.test(trimmed);
}

export async function showNicknameStep(ctx: NavaContext, lang: Language) {
  const t = dictionary(lang);
  const text = requireLocked(lang, "onboarding.nicknamePrompt", t.onboarding.nicknamePrompt);
  const sent = await ctx.reply(text, { parse_mode: "HTML" });
  await recordPrompt(ctx, sent.message_id);
}

export function registerNicknameHandlers(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.onboardingStep !== "NICKNAME_PENDING") {
      return next();
    }

    const t = dictionary(ctx.userLang);
    const raw = ctx.message.text;

    if (!isValidPersianNickname(raw)) {
      const errorText = requireLocked(ctx.userLang, "onboarding.nicknameInvalid", t.onboarding.nicknameInvalid);
      const sentError = await ctx.reply(errorText);
      // The error message itself becomes the new "previous message to
      // delete" once a valid nickname is eventually sent, per spec ("delete
      // the previous nickname request/error message where appropriate").
      await recordPrompt(ctx, sentError.message_id);
      return;
    }

    const result = await setNicknameOnce(ctx.from!.id, raw.trim());
    if (result.status !== "saved") return; // stale/duplicate — already progressed

    await deletePreviousPrompt(ctx);
    await showOnboardingCompletion(ctx, ctx.userLang);
  });
}
