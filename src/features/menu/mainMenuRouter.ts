import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { matchMainMenuAction, MENU_CALLBACKS } from "./mainMenu.js";
import { sendGuide, sendFeedbackInfo } from "./guide.js";
import { enterAnonymousMatching } from "../matching/entry.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { showOwnProfile } from "../matching/profile.js";
import { showRelicScreen } from "../payments/index.js";
import { sendInviteScreen } from "./inviteFriends.js";
import { showContactsList } from "../matching/contacts.js";

/**
 * Routes taps on the persistent (Reply Keyboard) main menu buttons — see
 * src/features/menu/mainMenu.ts — to the exact same logic the old inline
 * "glass" buttons used to trigger. A Reply Keyboard button has no
 * callback_data; tapping one just sends its label back as an ordinary text
 * message, so this has to live on `message:text`, matched by exact label
 * text across all 3 supported languages (see matchMainMenuAction).
 *
 * Only engages once onboarding is COMPLETED (the main menu is never shown
 * before then anyway), so it can never misfire on onboarding steps that
 * read raw text input (nickname, bio, etc.) even in the rare case a user
 * types text identical to a menu label.
 */
export function registerMainMenuRouter(composer: Composer<NavaContext>) {
  // Inline "راهنما" button under the onboarding completion message.
  composer.callbackQuery(MENU_CALLBACKS.guide, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendGuide(ctx);
  });

  composer.on("message:text", async (ctx, next) => {
    if (ctx.dbUser?.onboardingStep !== "COMPLETED") return next();
    if (ctx.dbUser?.activeChatSessionId) return next(); // in-chat text must always go to registerChatRelay

    const action = matchMainMenuAction(ctx.message.text);
    if (!action) return next();

    switch (action) {
      case "connectAnonymous": {
        const eligible = await requireChannelMembership(ctx, ctx.userLang);
        if (!eligible) return;
        await enterAnonymousMatching(ctx, ctx.userLang);
        return;
      }
      case "profile":
        await showOwnProfile(ctx);
        return;
      case "relicCoin":
        await showRelicScreen(ctx);
        return;
      case "inviteFriends":
        await sendInviteScreen(ctx);
        return;
      case "contacts":
        await showContactsList(ctx);
        return;
      case "guide":
        await sendGuide(ctx);
        return;
      case "feedback":
        await sendFeedbackInfo(ctx);
        return;
      case "nearbyPeople":
      case "searchUsers":
      case "myAnonymousLink":
        // Not implemented yet (same as the old inline buttons, which the
        // generic callback fallback silently acknowledged without taking
        // any action) — swallow the tap rather than falling through to the
        // "unknown input" error, since this IS a recognized menu button.
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  });
}
