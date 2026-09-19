import type { NavaContext } from "../../bot-context.js";
import { countReferralRewards } from "../../db/models/relic.js";
import { getContent, setContent } from "../../db/models/content.js";
import { env } from "../../config/env.js";
import { textEmoji } from "../../config/emojis.js";

/** The bot's own @username, used to build the referral deep link
 *  (t.me/<username>?start=<anonId>). Telegram gives no API for a bot to
 *  read its own username at request time without an extra API call, so
 *  this is the one thing that must be typed once, matching whatever
 *  BotFather actually gave this bot. */
const BOT_USERNAME = "NavaChatBot";

/** Admin-editable via the "🛠 راهنما / کانال جوین / پشتیبانی" panel (see
 *  guides.ts, ContentKey "inviteMessage"). The literal token `{{link}}` is
 *  substituted with each user's own referral link at send time — keep it
 *  in the text if you edit this from the admin panel. */
export function defaultInviteMessageTemplate(): string {
  const introEmoji = textEmoji("INVITE_INTRO", "💬");
  const anonEmoji = textEmoji("INVITE_ANON", "💬");
  const featuresEmoji = textEmoji("INVITE_FEATURES", "💬");
  const ctaEmoji = textEmoji("INVITE_CTA", "💬");
  const linkEmoji = textEmoji("INVITE_LINK", "💬");
  const verifiedEmoji = textEmoji("INVITE_VERIFIED", "☑️");
  const profileBonusEmoji = textEmoji("INVITE_PROFILE_BONUS", "➕");
  const referralBonusEmoji = textEmoji("INVITE_REFERRAL_BONUS", "💬");

  return (
    `${introEmoji}《نوا💬》هستم، با من میتونی👇\n\n` +
    `${anonEmoji} به صورت کاملا #ناشناس و رایگان با افرادی که اطرافتن و نزدیکن بهت آشنا بشی و #چت کنی ${anonEmoji}\n\n` +
    `${featuresEmoji} با کلی امکانات جذاب و جالب دیگه که باید بیای با چشمای خودت ببینی تا باور کنی ${featuresEmoji}\n\n` +
    `⁉️ پس چرا منتظری؟ ${ctaEmoji}\n\n` +
    `💬 همین الان روی لینک بزن 💬👇\n\n` +
    `${linkEmoji} {{link}} ${linkEmoji}\n` +
    `${linkEmoji} {{link}} ${linkEmoji}\n\n` +
    `${verifiedEmoji} #رایگان ، تایید شده و کاملا امن 💬\n\n` +
    `💬 راستی با تکمیل کردن پروفایلت ۵ رلیک ${profileBonusEmoji} با دعوت هر نفر به ربات ۲۰ رلیک رایگان دریافت میکنی! ${referralBonusEmoji}💬`
  );
}

export async function sendInviteScreen(ctx: NavaContext): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;

  const link = `https://t.me/${BOT_USERNAME}?start=${user.anonId}`;
  const template = await getContent("inviteMessage", defaultInviteMessageTemplate());
  const inviteText = template.split("{{link}}").join(link);

  if (env.INVITE_BANNER_PHOTO) {
    await ctx.replyWithPhoto(env.INVITE_BANNER_PHOTO, { caption: inviteText });
  } else {
    await ctx.reply(inviteText);
  }

  const count = await countReferralRewards(user._id);
  const bannerReadyEmoji = textEmoji("INVITE_BANNER_READY", "⚡️");
  const countEmoji = textEmoji("INVITE_COUNT", "👈");

  const relicEmoji = textEmoji("RELIC", "💰");
  const followUpText =
    `بنر حاوی لینک${bannerReadyEmoji} دعوت شما با موفقیت ساخته شد 👆\n\n` +
    `شما میتوانید بنر حاوی لینک${bannerReadyEmoji} خود را به گـــروه ها و دوستان خود ارسال کنید\n\n` +
    `با معرفی هر نفر ۲۰ رلیک${relicEmoji} رایگــان بگیرید!\n\n` +
    `${countEmoji} شما تاکنون ${count} نفر را به این ربات دعوت کرده اید.`;

  await ctx.reply(followUpText);
}
