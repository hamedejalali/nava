import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { clearTransferSession } from "../../db/models/transferSession.js";
import { glassButton, glassReplyButton, inlineKeyboard, replyKeyboard } from "../../ui/keyboard.js";
import { CANCEL_LABEL } from "./cancelLabel.js";
import { sendRestore } from "./keyboardState.js";
import { matchMainMenuAction } from "../menu/mainMenu.js";
import { isAdmin } from "../admin/constants.js";
import { ADMIN_MENU_LABELS, ADMIN_CATEGORY_LABELS } from "../admin/menu.js";
import { setAdminFlow } from "../admin/flowState.js";

/**
 * Every "the bot is waiting for the user's next message" step (profile edit,
 * name/age change request, verify request, report, relic transfer, anonymous
 * message ...) is stored as a small "flow" document. Two problems used to
 * exist:
 *   1. A user stuck in such a step who tapped ANY other menu button got a
 *      validation error ("سن باید یک عدد صحیح ...") instead of the button
 *      working, and had no way out.
 *   2. There was no visible cancel button.
 * This module fixes both, once, for every flow:
 *   - `cancelKeyboard()` — the red "❌ لغو" glass button to attach to every
 *     prompt (callback FLOW_CANCEL_CALLBACK, handled below).
 *   - `registerFlowInterrupt()` — tapping a main-menu button (or sending a
 *     /command) while in a flow ends that flow and lets the tap work.
 */

export const FLOW_CANCEL_CALLBACK = "flow:cancel";

/** The input-step cancel control (v1.26): ONE red «❌ لغو» reply-keyboard button — and nothing else on screen.
 *  It replaces whatever keyboard was shown; `restoreKeyboardIfDone` (src/features/common/keyboardState.ts) brings the
 *  previous one back when the step is over. Attach as `reply_markup` to any "waiting for input" prompt. */
export function cancelKeyboard() {
  return replyKeyboard([[glassReplyButton(CANCEL_LABEL, "danger")]]);
}

/** Old inline version, kept for messages that were sent by earlier versions (their callback still works). */
export function inlineCancelKeyboard() {
  return inlineKeyboard([[glassButton("❌ لغو", FLOW_CANCEL_CALLBACK, "danger")]]);
}

/** Ends every pending user-side flow for this user. Safe to call anytime. */
export async function clearAllUserFlows(userId: number): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection("profile_edit_flow").deleteOne({ _id: userId as never }),
    db.collection("verify_flow").deleteOne({ _id: userId as never }),
    db.collection("report_flow").deleteOne({ _id: userId as never }),
    db.collection("anon_msg_flow").deleteOne({ _id: userId as never }),
    db.collection("feedback_flow").deleteOne({ _id: userId as never }),
    db.collection("wallet_deposit_flow").deleteOne({ _id: userId as never }),
    // admin-panel steps (search / ban / broadcast / relic ...) use these:
    db.collection("admin_flow_state").deleteOne({ _id: userId as never }),
    db.collection("admin_relic_flow").deleteOne({ _id: userId as never }),
    clearTransferSession(userId),
  ]);
}

/** True while the user is inside a step that expects a PHOTO from them
 *  (verification selfie, report evidence). The generic profile-photo
 *  uploader must NOT treat such a photo as a new profile picture — before
 *  this check it did, so a verification selfie silently became the user's
 *  profile photo and never reached the admins. */
export async function hasPendingPhotoFlow(userId: number): Promise<boolean> {
  const db = await getDb();
  const [verify, report, anon, feedback] = await Promise.all([
    db.collection("verify_flow").findOne({ _id: userId as never }),
    db.collection("report_flow").findOne({ _id: userId as never, stage: "await_photo" }),
    db.collection("anon_msg_flow").findOne({ _id: userId as never }),
    db.collection("feedback_flow").findOne({ _id: userId as never }),
  ]);
  return !!verify || !!report || !!anon || !!feedback;
}

export function registerFlowCancel(composer: Composer<NavaContext>) {
  composer.callbackQuery(FLOW_CANCEL_CALLBACK, async (ctx) => {
    await clearAllUserFlows(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: "لغو شد ✅" });
    await ctx.deleteMessage().catch(() => {});
  });
}

/**
 * Must be installed BEFORE the feature handlers (see src/bot.ts).
 * A tap on a main-menu button, or a /command, always wins over a pending
 * "waiting for text" step: the step is cancelled and the update continues.
 * (Admins: tapping any admin-panel button likewise abandons the admin
 * flow that was waiting for text.)
 */
export function registerFlowInterrupt(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const user = ctx.dbUser;

    // the red «❌ لغو» keyboard button: ends EVERY pending step and brings the previous keyboard back
    if (text === CANCEL_LABEL && !user?.activeChatSessionId) {
      await clearAllUserFlows(ctx.from!.id);
      await setAdminFlow(ctx.from!.id, null);
      await sendRestore(ctx, "لغو شد ✅");
      return;
    }

    if (user && !user.activeChatSessionId) {
      const isCommand = text.startsWith("/");
      const isMenuTap = user.onboardingStep === "COMPLETED" && !!matchMainMenuAction(text);
      if (isCommand || isMenuTap) {
        await clearAllUserFlows(ctx.from!.id);
      }
    }

    // Any admin-panel button (main panel, category, back, close) abandons EVERY pending text step —
    // including the relic/ژتون step (admin_relic_flow) that used to swallow the next taps with
    // «آیدی معتبر نیست».
    const adminTap =
      isAdmin(ctx) &&
      ((Object.values(ADMIN_MENU_LABELS) as string[]).includes(text) ||
        (Object.values(ADMIN_CATEGORY_LABELS) as string[]).includes(text) ||
        !!matchMainMenuAction(text) ||
        text.startsWith("/"));
    if (adminTap) {
      await setAdminFlow(ctx.from!.id, null);
      await clearAllUserFlows(ctx.from!.id);
    }

    await next();
  });
}
