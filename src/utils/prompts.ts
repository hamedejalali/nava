import type { NavaContext } from "../bot-context.js";
import { setLastPromptMessageId } from "../db/models/user.js";

/** Deletes the previously recorded prompt message (if any) for this user.
 *  Safe to call unconditionally — silently no-ops if there is nothing to
 *  delete or the message is already gone (e.g. manually deleted by the
 *  user, or older than Telegram's delete window). */
export async function deletePreviousPrompt(ctx: NavaContext): Promise<void> {
  const messageId = ctx.dbUser?.lastPromptMessageId;
  if (!messageId || !ctx.chat) return;
  await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  await setLastPromptMessageId(ctx.from!.id, undefined);
}

/** Records the message ID of a just-sent "waiting for an answer" prompt so
 *  it can be reliably deleted later via deletePreviousPrompt, regardless of
 *  whether the eventual answer arrives as a callback on that same message
 *  or as a separate text message. */
export async function recordPrompt(ctx: NavaContext, sentMessageId: number): Promise<void> {
  await setLastPromptMessageId(ctx.from!.id, sentMessageId);
}
