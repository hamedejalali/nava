import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { getUserByAnonId } from "../../db/models/user.js";
import { textEmoji } from "../../config/emojis.js";
import { buildProfileText, buildProfileKeyboard, resolveProfilePhoto, shouldNotifyProfileView } from "./profile.js";

const ANON_ID_PATTERN = /^[@/]?(user_[A-Za-z0-9]{6})$/;

/** Must run AFTER registerChatRelay (in-chat text always wins) but can run
 *  anywhere relative to onboarding, since a real anonId never collides
 *  with a nickname/age/city answer in practice, and this only ever acts
 *  when onboarding is already COMPLETED. */
export function registerProfileLookup(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!ctx.dbUser || ctx.dbUser.onboardingStep !== "COMPLETED") return next();
    if (ctx.dbUser.activeChatSessionId) return next(); // already connected — chat relay owns this

    const match = ANON_ID_PATTERN.exec(ctx.message.text.trim());
    if (!match) return next();

    const anonId = match[1]!;
    if (anonId === ctx.dbUser.anonId) return next(); // looking up yourself — ignore, not an error

    const target = await getUserByAnonId(anonId);
    if (!target) {
      await ctx.reply("کاربری با این آیدی پیدا نشد.");
      return;
    }

    const text = buildProfileText(ctx.userLang, target, ctx.dbUser);
    const kb = buildProfileKeyboard(ctx.userLang, target, "lookup");
    const photo = resolveProfilePhoto(target);

    if (photo) {
      await ctx.replyWithPhoto(photo, { caption: text, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }

    // Same "someone viewed your profile" notification as the in-chat
    // partner-profile button — one shared cooldown, so a user can't be
    // spammed by repeated lookups either.
    if (!(await shouldNotifyProfileView(ctx.dbUser._id, target._id))) return;

    const targetLang: Language = target.languageCode ?? "fa";
    const t = dictionary(targetLang);
    const notifyTemplate = requireLocked(targetLang, "matching.profileViewNotification", t.matching.profileViewNotification);
    const navaEmoji = textEmoji("NAVA", "🌐");
    const notifyText = notifyTemplate.split("{{NAVA_EMOJI}}").join(navaEmoji);
    await ctx.api.sendMessage(target._id, notifyText, { parse_mode: "HTML" }).catch(() => {});
  });
}
