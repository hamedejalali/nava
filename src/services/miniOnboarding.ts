import { getDb } from "../db/connect.js";
import { getOrCreateUser, type UserDoc } from "../db/models/user.js";
import { grantProfileCompletionRewardOnce } from "../db/models/relic.js";
import { PROVINCES } from "../data/provinces.js";
import { citiesForProvince, isValidCityForProvince } from "../data/cities.js";
import { isValidPersianNickname } from "../features/onboarding/nickname.js";
import { MAX_AGE, MIN_AGE } from "../features/matching/profileEdit.js";
import { dictionary } from "../i18n/index.js";
import { buildMainMenuReplyKeyboard } from "../features/menu/mainMenu.js";
import type { TelegramWebAppUser } from "../utils/telegramWebApp.js";

/**
 * Registration INSIDE the Mini App for people who opened it before finishing the bot's questions.
 * It fills exactly the same fields as the bot's steps (language fa, gender, age, province, city, nickname),
 * ends in the same state (`onboardingStep: "COMPLETED"`), pays the same one-time profile bonus, and sends the same
 * "profile complete + main menu" message into the bot chat — so the bot and the app always agree.
 * Only possible while the account is NOT completed; the write is a single guarded update, so a double tap or a
 * parallel bot registration can never complete it twice.
 */

export interface OnboardState {
  completed: boolean;
  gender: "male" | "female" | null;
  age: number | null;
  province: string | null;
  city: string | null;
  nickname: string | null;
  provinces: Array<{ id: string; name: string }>;
  minAge: number;
  maxAge: number;
}

async function ensureUser(tg: TelegramWebAppUser): Promise<UserDoc> {
  return (await getOrCreateUser({ telegramId: tg.id, firstName: tg.first_name, username: tg.username })) as UserDoc;
}

export async function onboardState(tg: TelegramWebAppUser): Promise<OnboardState | { banned: true }> {
  const u = await ensureUser(tg);
  if (u.banned) return { banned: true };
  return {
    completed: u.onboardingStep === "COMPLETED",
    gender: (u.gender as any) ?? null,
    age: typeof u.age === "number" ? u.age : null,
    province: u.province ?? null,
    city: u.city ?? null,
    nickname: u.nickname ?? null,
    provinces: PROVINCES.map((p) => ({ id: p.id, name: p.nameFa })),
    minAge: MIN_AGE,
    maxAge: MAX_AGE,
  };
}

export function onboardCities(province: unknown): Array<{ id: string; name: string }> | null {
  if (typeof province !== "string" || !PROVINCES.some((p) => p.id === province)) return null;
  return citiesForProvince(province).map((c) => ({ id: c.id, name: c.nameFa }));
}

export type OnboardInput = { gender: unknown; age: unknown; province: unknown; city: unknown; nickname: unknown };
export type OnboardResult =
  | { status: "completed" }
  | { status: "already" }
  | { status: "banned" }
  | { status: "invalid"; field: "gender" | "age" | "province" | "city" | "nickname" };

export async function onboardSave(tg: TelegramWebAppUser, input: OnboardInput, api?: { sendMessage: (id: number, text: string, o?: any) => Promise<unknown> }): Promise<OnboardResult> {
  const gender = input.gender === "male" || input.gender === "female" ? input.gender : null;
  if (!gender) return { status: "invalid", field: "gender" };
  const ageN = typeof input.age === "number" ? input.age : typeof input.age === "string" && /^\d{1,3}$/.test(input.age.trim()) ? Number(input.age.trim()) : NaN;
  if (!Number.isInteger(ageN) || ageN < MIN_AGE || ageN > MAX_AGE) return { status: "invalid", field: "age" };
  if (typeof input.province !== "string" || !PROVINCES.some((p) => p.id === input.province)) return { status: "invalid", field: "province" };
  if (typeof input.city !== "string" || !isValidCityForProvince(input.city, input.province)) return { status: "invalid", field: "city" };
  if (typeof input.nickname !== "string" || !isValidPersianNickname(input.nickname)) return { status: "invalid", field: "nickname" };

  const u = await ensureUser(tg);
  if (u.banned) return { status: "banned" };
  if (u.onboardingStep === "COMPLETED") return { status: "already" };

  const db = await getDb();
  const done = await db.collection<any>("users").findOneAndUpdate(
    { _id: tg.id, onboardingStep: { $ne: "COMPLETED" }, banned: { $ne: true } },
    { $set: { languageCode: "fa", gender, age: ageN, province: input.province, city: input.city, nickname: input.nickname.trim(), onboardingStep: "COMPLETED", lastActivityAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!done) return { status: "already" };

  await grantProfileCompletionRewardOnce(tg.id).catch(() => {});
  if (api) {
    const t = dictionary("fa");
    await api.sendMessage(tg.id, t.onboarding.completionMessage as string, { parse_mode: "HTML" }).catch(() => {});
    await api.sendMessage(tg.id, t.onboarding.chooseFromMenu as string, { reply_markup: buildMainMenuReplyKeyboard("fa") }).catch(() => {});
  }
  return { status: "completed" };
}
