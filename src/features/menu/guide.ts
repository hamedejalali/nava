import type { NavaContext } from "../../bot-context.js";
import { getContent } from "../../db/models/content.js";
import { fa } from "../../i18n/locales/fa.js";
import { inlineKeyboard } from "../../ui/keyboard.js";
import { buildSupportButton } from "../support/index.js";

/** "راهنما" button: shows the admin-editable Guide 1 text (edit it in the
 *  admin panel: ویرایش راهنما ها -> راهنمای شماره یک). Previously the
 *  button was a silent no-op even though the welcome message tells users
 *  to tap it. */
export async function sendGuide(ctx: NavaContext): Promise<void> {
  const text = await getContent("guide1", fa.onboarding.guide1!);
  const support = await buildSupportButton("آیدی پشتیبانی");
  await ctx.reply(text, { reply_markup: support ? inlineKeyboard([[support]]) : undefined });
}

/** "پیشنهادات و انتقادات": hands the user the support contact. */
export async function sendFeedbackInfo(ctx: NavaContext): Promise<void> {
  const support = await buildSupportButton("پیام به پشتیبانی");
  if (!support) {
    await ctx.reply("فعلاً آیدی پشتیبانی تنظیم نشده. کمی بعد دوباره امتحان کن 🙏");
    return;
  }
  await ctx.reply("پیشنهاد یا انتقادی داری؟ با تیم پشتیبانی در میون بذار 👇", { reply_markup: inlineKeyboard([[support]]) });
}
