import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { escapeHtml } from "../../utils/html.js";
import { textEmoji } from "../../config/emojis.js";
import { isOwner, isAdmin } from "./constants.js";
import { buildAdminReplyKeyboard, ADMIN_MENU_LABELS } from "./menu.js";
import { removeReplyKeyboard } from "../../ui/keyboard.js";
import type { UserDoc } from "../../db/models/user.js";
import { usersCollectionDirectSet } from "../../db/models/user.js";

/** Sent instead of the normal onboarding welcome for the owner/any admin —
 *  they skip gender/age/province/city/nickname entirely and go straight
 *  to the admin panel, per explicit request. */
export async function sendOwnerAdminWelcome(ctx: NavaContext, user: UserDoc, firstName: string): Promise<void> {
  const owner = isOwner(ctx);
  const badge = owner ? textEmoji("OWNER_BADGE", "👑") : textEmoji("ADMIN_BADGE", "🛡️");
  const roleLabel = owner ? "مالک" : "ادمین";

  // Ensure onboarding is marked complete for this account so no other part
  // of the bot ever tries to route it back through the user-facing flow.
  if (user.onboardingStep !== "COMPLETED") {
    await usersCollectionDirectSet(user._id, { onboardingStep: "COMPLETED" });
  }

  await ctx.reply(`سلام ${escapeHtml(firstName)} ${badge}\n\nخوش اومدی ${roleLabel} عزیز — پنل مدیریت روی کیبورد بازه 👇`, {
    parse_mode: "HTML",
    reply_markup: buildAdminReplyKeyboard(ctx),
  });
}

export function registerOwnerAdminPanelClose(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.close) return next();
    await ctx.reply("پنل بسته شد.", { reply_markup: removeReplyKeyboard() });
  });
}
