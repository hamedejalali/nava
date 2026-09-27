import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getUserByAnonId } from "../../db/models/user.js";
import { env } from "../../config/env.js";
import { isAdmin } from "../admin/constants.js";
import { sendRevealNotification } from "./profileReveal.js";
import { buildProfileKeyboard, replyWithProfile, shouldNotifyProfileView } from "./profile.js";

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

    await replyWithProfile(ctx, target, ctx.dbUser, buildProfileKeyboard(ctx.userLang, target, "lookup"));

    // Admins/owner looking users up (moderation) never trigger anything on
    // the other side — no notice, no charge.
    if (isAdmin(ctx) && !env.PROFILE_VIEW_NOTIFY_ADMIN_LOOKUPS) return;

    // NEW behaviour (only when the viewer is NOT in a chat): the profile
    // owner gets an ANONYMOUS notice with a "پرداخت" button; paying
    // PROFILE_VIEW_REVEAL_COST Relic reveals who looked. The old
    // "مخاطب شما پروفایلِ نوا شما را مشاهده کرد" text is only for the
    // in-chat "پروفایل مخاطب" button (see profile.ts).
    if (!(await shouldNotifyProfileView(ctx.dbUser._id, target._id, "lookup"))) return;
    await sendRevealNotification(ctx.api, ctx.dbUser._id, target);
  });
}
