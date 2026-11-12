import type { Bot, Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { getOrCreateUser } from "../../db/models/user.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { FORCE_JOIN_VERIFY_CALLBACK } from "../forcejoin/constants.js";
import { glassButton, inlineKeyboard, toAsciiDigitsSafe } from "./inviteUi.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { buildAgeReplyKeyboard } from "../onboarding/age.js";
import { isValidEnglishNickname, completeOnboardingWithNickname } from "../onboarding/nickname.js";
import { showGenderStep } from "../onboarding/gender.js";
import { showProvinceStep } from "../onboarding/province.js";
import { showCityStep } from "../onboarding/city.js";
import { MIN_AGE, MAX_AGE } from "../matching/profileEdit.js";
import { INVITE_GAMES } from "../../services/games/index.js";
import { ensureInvite, getInvite, INVITE_TOKEN_RE } from "../../services/games/invites.js";
import { getAppVar, APP_VAR_KEYS } from "../../services/appVars.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { escapeHtml } from "../../utils/html.js";
import { getMaintenanceState, maintenanceAllows } from "../../services/maintenance.js";

/**
 * v1.30.0 — game invites through the inline list.
 *   1) anybody types «@bot » in any chat → the games; the chosen one lands in the chat as photo + text + ONE button  (inline_query below)
 *   2) the button opens the bot with  /start ig_<token>:  forced-join → English name → age → «ورود به بازی» (Mini App, straight on the table)
 *      + the main reply keyboard. Until the rest of the profile is finished every main button answers «complete your info» with a «شروع»
 *      button that runs the remaining steps one at a time (gender → province → city). Name + age are the only entry conditions; city and
 *      photo never block a game, and the age-band rule (F-09) is enforced when the second player sits down.
 */
export const INVITE_START_RE = /^ig_([A-Za-z0-9_-]{16})$/;
export const INVITE_GO_CALLBACK = "inv:go";

type Step = "JOIN" | "NAME" | "AGE" | "READY" | "DONE";
interface Flow { token: string; step: Step }

export function inviteAppUrl(token: string): string | null {
  const base = env.NAVA_MINIAPP_URL;
  if (!base) return null;
  try {
    const u = new URL(base);
    u.searchParams.set("go", `ig_${token}`);
    return u.toString();
  } catch {
    return null;
  }
}

const flowOf = (ctx: NavaContext): Flow | null => {
  const f = (ctx.dbUser as any)?.inviteFlow;
  return f && typeof f.token === "string" && typeof f.step === "string" ? (f as Flow) : null;
};

async function setFlow(ctx: NavaContext, flow: Flow | null): Promise<void> {
  const db = await getDb();
  await db.collection<any>("users").updateOne({ _id: ctx.from!.id }, flow ? { $set: { inviteFlow: flow } } : { $unset: { inviteFlow: "" } });
  if (ctx.dbUser) (ctx.dbUser as any).inviteFlow = flow ?? undefined;
}

const NAME_PROMPT = "📝 اول یه اسم نمایشی انتخاب کن.\nفقط با <b>حروف انگلیسی</b> (A-Z) بنویس؛ مثلاً: Sara یا Ali Reza 👇";
const AGE_PROMPT = "🎂 حالا سنت رو بگو (عدد، یا از دکمه‌ها انتخاب کن) 👇";

async function askName(ctx: NavaContext, token: string, retry = false): Promise<void> {
  await setFlow(ctx, { token, step: "NAME" });
  await ctx.reply((retry ? "⚠️ فقط حروف انگلیسی (A-Z) و فاصله، حداکثر ۳۲ حرف.\n\n" : "") + NAME_PROMPT, { parse_mode: "HTML" });
}

async function askAge(ctx: NavaContext, token: string): Promise<void> {
  await setFlow(ctx, { token, step: "AGE" });
  await ctx.reply(AGE_PROMPT, { reply_markup: buildAgeReplyKeyboard() });
}

function enterButton(token: string, label = "🎲 ورود به بازی") {
  const url = inviteAppUrl(token);
  return url ? { inline_keyboard: [[{ text: label, web_app: { url }, style: "success" } as any]] } : undefined;
}

/** name + age are in: the main keyboard and ONE glass «ورود به بازی» button */
async function showReady(ctx: NavaContext, token: string, user: any): Promise<void> {
  const complete = user?.onboardingStep === "COMPLETED";
  await setFlow(ctx, complete ? null : { token, step: "READY" });
  await ctx.reply(complete ? "✅ همه‌چیز آماده‌ست." : "✅ اسم و سنت ثبت شد. بقیه‌ی اطلاعاتت رو بعداً کامل می‌کنی؛ برای بازی همین کافیه.", { reply_markup: buildMainMenuReplyKeyboard("fa") });
  const kb = enterButton(token);
  if (!kb) return void (await ctx.reply("🎲 بازی الان در دسترس نیست."));
  await ctx.reply("🎲 دعوت به بازی آماده‌ست؛ برای ورود دکمه‌ی زیر رو بزن 👇", { reply_markup: kb });
}

/** after forced-join (or at once when there is none): ask whatever is still missing, or show the entry button */
export async function proceedInvite(ctx: NavaContext, token: string): Promise<void> {
  const db = await getDb();
  const user: any = await db.collection<any>("users").findOne({ _id: ctx.from!.id });
  if (!user) return;
  if (user.onboardingStep !== "COMPLETED" || typeof user.age !== "number") {
    if (typeof user.nickname !== "string" || !isValidEnglishNickname(user.nickname)) return askName(ctx, token);
    if (typeof user.age !== "number") return askAge(ctx, token);
  }
  return showReady(ctx, token, user);
}

/** called by the forced-join «عضو شدم» button: continues an invite that was waiting for the channels */
export async function continueInviteAfterJoin(ctx: NavaContext): Promise<boolean> {
  const f = flowOf(ctx);
  if (!f || f.step !== "JOIN") return false;
  await proceedInvite(ctx, f.token);
  return true;
}

const NOTICE = "ℹ️ برای استفاده از این بخش باید اطلاعاتت رو کامل کنی.\nدکمه‌ی «شروع» زیر همین پیام رو بزن تا مرحله‌ها یکی‌یکی انجام بشه 👇";

async function resumeRemaining(ctx: NavaContext): Promise<void> {
  const db = await getDb();
  const id = ctx.from!.id;
  const col = db.collection<any>("users");
  await col.updateOne({ _id: id }, { $set: { languageCode: "fa" }, $unset: { inviteFlow: "" } });
  if (ctx.dbUser) { (ctx.dbUser as any).inviteFlow = undefined; (ctx.dbUser as any).languageCode = "fa"; }
  const u: any = await col.findOne({ _id: id });
  if (!u) return;
  if (u.onboardingStep === "COMPLETED") return void (await ctx.reply("✅ اطلاعاتت کامله.", { reply_markup: buildMainMenuReplyKeyboard("fa") }));
  if (!u.gender) {
    await col.updateOne({ _id: id }, { $set: { onboardingStep: "GENDER_PENDING" } });
    if (ctx.dbUser) (ctx.dbUser as any).onboardingStep = "GENDER_PENDING";
    return showGenderStep(ctx, "fa");
  }
  if (!u.province) {
    await col.updateOne({ _id: id }, { $set: { onboardingStep: "AGE_DONE" } });
    if (ctx.dbUser) (ctx.dbUser as any).onboardingStep = "AGE_DONE";
    return showProvinceStep(ctx, "fa");
  }
  if (!u.city) {
    await col.updateOne({ _id: id }, { $set: { onboardingStep: "CITY_PENDING" } });
    if (ctx.dbUser) (ctx.dbUser as any).onboardingStep = "CITY_PENDING";
    return showCityStep(ctx, "fa", u.province);
  }
  await col.updateOne({ _id: id }, { $set: { onboardingStep: "NICKNAME_PENDING" } });
  await completeOnboardingWithNickname(ctx, String(u.nickname));
}

export function registerInviteStart(composer: Composer<NavaContext>) {
  composer.command("start", async (ctx, next) => {
    const m = INVITE_START_RE.exec(ctx.match?.trim() ?? "");
    if (!m || !ctx.from) return next();
    const token = m[1]!;
    const inv = await getInvite(token);
    if (!inv) return void (await ctx.reply("🎲 این دعوت منقضی شده؛ از دوستت بخواه دوباره بفرستش."));
    const user = await getOrCreateUser({ telegramId: ctx.from.id, firstName: ctx.from.first_name, username: ctx.from.username });
    ctx.dbUser = ctx.dbUser ?? (user as any);
    // remember the invite BEFORE the channel screen so «عضو شدم» can continue it
    await setFlow(ctx, { token, step: "JOIN" });
    if (!(await requireChannelMembership(ctx, (user.languageCode ?? "fa") as any))) return;
    await proceedInvite(ctx, token);
  });

  composer.callbackQuery(INVITE_GO_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await resumeRemaining(ctx);
  });

  // the invite's own questions (name, age) and the «complete your info» answer for every other tap
  composer.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return next();
    const f = flowOf(ctx);
    const u: any = ctx.dbUser;
    if (!f || !u) return next();
    if (u.onboardingStep === "COMPLETED") {
      if (f.step !== "JOIN") await setFlow(ctx, null);
      return next();
    }
    if (f.step === "NAME" && ctx.message?.text && !ctx.message.text.startsWith("/")) {
      const raw = ctx.message.text.trim();
      if (!isValidEnglishNickname(raw)) return void (await askName(ctx, f.token, true));
      const db = await getDb();
      // only while the account is unfinished (a finished account changes its name through the normal, announced path)
      const nr = await db.collection<any>("users").updateOne({ _id: ctx.from.id, onboardingStep: { $ne: "COMPLETED" } }, { $set: { nickname: raw } });
      if (nr.matchedCount !== 1) return next();
      u.nickname = raw;
      return typeof u.age === "number" ? showReady(ctx, f.token, u) : askAge(ctx, f.token);
    }
    if (f.step === "AGE" && ctx.message?.text && !ctx.message.text.startsWith("/")) {
      const raw = toAsciiDigitsSafe(ctx.message.text.trim());
      const age = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) return void (await ctx.reply("⚠️ سن معتبر نیست؛ یه عدد درست بفرست."));
      const db = await getDb();
      // age is written ONCE: a second / concurrent answer can not overwrite it (later changes go through the approval flow, F-01)
      const ar = await db.collection<any>("users").updateOne({ _id: ctx.from.id, onboardingStep: { $ne: "COMPLETED" }, age: { $exists: false } }, { $set: { age } });
      if (ar.matchedCount !== 1) {
        const fresh: any = await db.collection<any>("users").findOne({ _id: ctx.from.id }, { projection: { age: 1, nickname: 1, onboardingStep: 1 } });
        if (typeof fresh?.age !== "number") return next();
        u.age = fresh.age;
      } else u.age = age;
      return showReady(ctx, f.token, u);
    }
    if (f.step === "NAME" || f.step === "AGE") {
      // a button / command in the middle of the questions: say what is expected instead of going elsewhere
      if (ctx.callbackQuery && ctx.callbackQuery.data === FORCE_JOIN_VERIFY_CALLBACK) return next();
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "اول به سؤال بالا جواب بده 🙏" }).catch(() => {});
      return void (f.step === "NAME" ? await askName(ctx, f.token) : await askAge(ctx, f.token));
    }
    if (f.step === "READY") {
      const data = ctx.callbackQuery?.data ?? "";
      if (data === FORCE_JOIN_VERIFY_CALLBACK) return next();
      if (!ctx.message && !ctx.callbackQuery) return next();
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      await ctx.reply(NOTICE, { reply_markup: inlineKeyboard([[glassButton("▶️ شروع", INVITE_GO_CALLBACK, "success")]]) });
      return;
    }
    return next();
  });
}

/** «@bot » in any chat: the list of games (one result per game; the button opens the bot with an opaque invite token) */
export function registerInlineGames(bot: Bot<NavaContext>) {
  bot.on("inline_query", async (ctx) => {
    const from = ctx.from;
    const answer = (results: any[]) => ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true }).catch(() => {});
    if (!INVITE_GAMES.length) return void (await answer([]));
    if (from.is_bot) return void (await answer([]));
    // read-only checks (no account is created here): banned people and a switched-off bot get an empty list
    const known: any = await (await getDb()).collection<any>("users").findOne({ _id: from.id }, { projection: { banned: 1, isAdmin: 1 } });
    if (known?.banned) return void (await answer([]));
    const mt = await getMaintenanceState();
    if (!maintenanceAllows(mt, from.id, known)) return void (await answer([]));
    const rl = await checkRateLimit(from.id, "inline", 20, 60_000).catch(() => ({ allowed: true }));
    if (!rl.allowed) return void (await answer([]));
    const q = (ctx.inlineQuery.query ?? "").trim().toLowerCase();
    const botName = (ctx.me?.username ?? "").replace(/^@/, "");
    const photo = await getAppVar(APP_VAR_KEYS.GAME_SHARE_PHOTO);
    const results: any[] = [];
    for (const g of INVITE_GAMES) {
      if (q && !g.title.toLowerCase().includes(q) && !g.id.includes(q)) continue;
      const token = await ensureInvite(from.id, g.id);
      const link = `https://t.me/${botName}?start=ig_${token}`;
      const caption = `🎲 <b>یه دست ${escapeHtml(g.title)} با من بازی می‌کنی؟</b>\n\nبرای ورود به بازی دکمه‌ی زیر رو بزن 👇`;
      const reply_markup = { inline_keyboard: [[{ text: "🎮 شروع بازی", url: link, style: "success" } as any]] };
      const id = `${g.id}-${token}`.slice(0, 64);
      results.push(
        photo
          ? { type: "photo", id, photo_file_id: photo, title: g.title, description: g.invite!.description, caption, parse_mode: "HTML", reply_markup }
          : { type: "article", id, title: `🎲 ${g.title}`, description: g.invite!.description, input_message_content: { message_text: caption, parse_mode: "HTML" }, reply_markup },
      );
    }
    await answer(results);
  });
}

export { INVITE_TOKEN_RE };
