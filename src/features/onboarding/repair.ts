import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";
import { isOfficial } from "../../services/nava/common.js";
import type { OnboardingStep } from "../../db/models/user.js";
import { showGenderStep } from "./gender.js";
import { showGuide1AndAge } from "./age.js";
import { showProvinceStep } from "./province.js";
import { showCityStep } from "./city.js";
import { showNicknameStep } from "./nickname.js";

/**
 * A real account can never be «completed» without a name and an age (an Excel restore / an old reset used to leave such rows:
 * «نام: - سن: -»). The first missing answer decides which step the person is put back on.
 */
export function firstMissingStep(u: { gender?: unknown; age?: unknown; province?: unknown; city?: unknown; nickname?: unknown }): OnboardingStep | null {
  if (!u.gender) return "GENDER_PENDING";
  if (typeof u.age !== "number") return "AGE_PENDING";
  if (!u.province) return "AGE_DONE";
  if (!u.city) return "CITY_PENDING";
  if (typeof u.nickname !== "string" || !u.nickname.trim()) return "NICKNAME_PENDING";
  return null;
}

/** «completed» but a basic answer is missing (name, age, province or city) → back to the first missing question. */
export function isBrokenCompleted(u: any): boolean {
  if (!u || u.onboardingStep !== "COMPLETED") return false;
  if (u.isSeed || isOfficial(u) || u.banned) return false;
  if (env.OWNER_ID !== undefined && u._id === env.OWNER_ID) return false;
  return firstMissingStep(u) !== null;
}

/** Returns true when the person was sent back into the questions (the current update must then stop). */
export async function resumeIfBroken(ctx: NavaContext): Promise<boolean> {
  const u: any = ctx.dbUser;
  if (!ctx.from || ctx.chat?.type !== "private" || !(ctx.message || ctx.callbackQuery)) return false;
  if (!isBrokenCompleted(u) || u.activeChatSessionId) return false;
  const step = firstMissingStep(u);
  if (!step) return false;
  const db = await getDb();
  await db.collection<any>("users").updateOne({ _id: u._id, onboardingStep: "COMPLETED" }, { $set: { onboardingStep: step } });
  u.onboardingStep = step;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const lang = (ctx.userLang ?? "fa") as any;
  await ctx.reply("پروفایلت کامل نیست؛ بیا چند تا سؤال کوتاه رو جواب بدی 🙏").catch(() => {});
  if (step === "GENDER_PENDING") await showGenderStep(ctx, lang);
  else if (step === "AGE_PENDING") await showGuide1AndAge(ctx, lang);
  else if (step === "AGE_DONE") await showProvinceStep(ctx, lang);
  else if (step === "CITY_PENDING" && u.province) await showCityStep(ctx, lang, u.province);
  else await showNicknameStep(ctx, lang);
  return true;
}
