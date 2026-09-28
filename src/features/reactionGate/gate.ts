import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, glassUrlButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import {
  GATE_WAIT_MS,
  gateElapsedMs,
  getGateSettings,
  hasPassedGate,
  markGatePassed,
  markGateShown,
} from "../../db/models/reactionGate.js";
import { isAdmin } from "../admin/constants.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";

export const GATE_CHECK_CALLBACK = "reactiongate:check";

/**
 * Returns true when the user may proceed. Shows the gate (and returns
 * false) when it is ON, correctly configured, and the user hasn't passed
 * this version of it yet.
 *
 * Fail-OPEN by design: this gate is a growth tool, never a lock. If it is
 * enabled but has no usable link, or anything about it throws (database
 * hiccup, ...), the user is let through and the problem is only logged —
 * a broken gate must never take the whole bot down.
 */
export async function requireReactionGate(ctx: NavaContext): Promise<boolean> {
  try {
    if (!ctx.from || isAdmin(ctx)) return true;

    const settings = await getGateSettings();
    if (!settings.enabled || !settings.buttonUrl) return true;
    if (await hasPassedGate(ctx.from.id, settings.version)) return true;

    await markGateShown(ctx.from.id, settings.version);
    await ctx.reply(settings.message, {
      reply_markup: inlineKeyboard([
        [glassUrlButton(settings.buttonText, settings.buttonUrl, "primary", buttonIcon("CHANNEL"))],
        [glassButton("بررسی", GATE_CHECK_CALLBACK, "success", buttonIcon("GREEN_CHECK"))],
      ]),
    });
    return false;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[reactionGate] check failed, letting the user through:", err);
    return true;
  }
}

export function registerReactionGate(composer: Composer<NavaContext>) {
  composer.callbackQuery(GATE_CHECK_CALLBACK, async (ctx) => {
    const settings = await getGateSettings();
    const userId = ctx.from!.id;

    if (!settings.enabled || (await hasPassedGate(userId, settings.version))) {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      return;
    }

    const elapsed = await gateElapsedMs(userId, settings.version);
    if (elapsed === null) {
      // Their timer belonged to an older version of the gate (it changed
      // while this message sat in their chat): start it now.
      await markGateShown(userId, settings.version);
    }
    if (elapsed === null || elapsed < GATE_WAIT_MS) {
      await ctx.answerCallbackQuery({
        text: "هنوز کاری که گفته شده رو انجام ندادی ❌\nبعد از انجامش دوباره «بررسی» رو بزن.",
        show_alert: true,
      });
      return;
    }

    await markGatePassed(userId, settings.version);
    await ctx.answerCallbackQuery({ text: "✅ تایید شد" });
    await ctx.deleteMessage().catch(() => {});
    const user = ctx.dbUser;
    await ctx.reply(
      "✅ ممنون! حالا می‌تونی از ربات استفاده کنی.",
      user?.onboardingStep === "COMPLETED" ? { reply_markup: buildMainMenuReplyKeyboard(ctx.userLang) } : undefined
    );
  });
}
