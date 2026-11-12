import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";
import { isAdmin } from "../admin/constants.js";
import { isOfficial } from "../../services/nava/common.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { isValidEnglishNickname, nicknameNeedsEnglish } from "./nickname.js";

/** v1.30.0 — a finished account whose name is not English (old Persian names) must change it before anything else.
 *  Owner, admins, seed/official accounts and banned users are exempt; a person inside a running chat is not interrupted. */
export function needsEnglishNameFix(ctx: NavaContext): boolean {
  const u: any = ctx.dbUser;
  if (!u || u.onboardingStep !== "COMPLETED") return false;
  if (u.isSeed || isOfficial(u) || u.banned) return false;
  if (isAdmin(ctx) || (env.OWNER_ID !== undefined && u._id === env.OWNER_ID)) return false;
  if (u.activeChatSessionId) return false;
  return nicknameNeedsEnglish(u.nickname);
}

const PROMPT =
  "📝 قانون جدید: اسم نمایشی همه باید <b>انگلیسی</b> باشه.\n" +
  "اسمت رو فقط با حروف انگلیسی (A-Z) و فاصله بفرست؛ حداکثر ۳۲ حرف. مثلاً: Sara یا Ali Reza 👇";

/** Returns true when the update was consumed by the name gate (the caller must stop). */
export async function enforceEnglishName(ctx: NavaContext): Promise<boolean> {
  if (!ctx.from || ctx.chat?.type !== "private" || !(ctx.message || ctx.callbackQuery)) return false;
  if (!needsEnglishNameFix(ctx)) return false;
  const u: any = ctx.dbUser;
  const text = ctx.message?.text;
  if (text && !text.startsWith("/") && isValidEnglishNickname(text)) {
    const value = text.trim();
    const db = await getDb();
    // a plain, awaited write (an error is NOT swallowed: the person is told only after it really happened); guarded by the old name so a
    // concurrent change is not overwritten. No notice to the admins — it is a forced one-time migration, not a user-initiated rename.
    const r = await db.collection<any>("users").updateOne({ _id: u._id, nickname: u.nickname }, { $set: { nickname: value }, $unset: { nicknameFixPending: "" } });
    if (r.matchedCount !== 1) return false;
    u.nickname = value;
    await ctx.reply("✅ اسمت ثبت شد. حالا می‌تونی ادامه بدی.", { reply_markup: buildMainMenuReplyKeyboard((ctx.userLang ?? "fa") as any) });
    return true;
  }
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "اول اسمت رو انگلیسی کن 🙏", show_alert: false }).catch(() => {});
  const invalid = !!text && !text.startsWith("/");
  if (!u.nicknameFixPending) {
    const db = await getDb();
    await db.collection<any>("users").updateOne({ _id: u._id }, { $set: { nicknameFixPending: true } });
    u.nicknameFixPending = true;
  }
  await ctx.reply(invalid ? "⚠️ فقط حروف انگلیسی (A-Z) و فاصله، حداکثر ۳۲ حرف.\n\n" + PROMPT : PROMPT, { parse_mode: "HTML" });
  return true;
}
