import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { findRelayedMessage } from "../../db/models/chatRelayMap.js";
import { getSession } from "../../db/models/chatSession.js";

/**
 * Real, server-backed message reactions inside an active anonymous chat.
 *
 * Telegram delivers a `message_reaction` update whenever a user reacts to a
 * message IN A CHAT WHERE THE BOT IS A PARTICIPANT — here that's always the
 * recipient's own private chat with the bot, reacting to the copy of a
 * message the bot relayed to them. We look up which original message (in
 * the SENDER's chat) that delivered copy corresponds to, and mirror the
 * same reaction there via `setMessageReaction`, so both sides see live
 * reactions without the bot ever storing any message content.
 *
 * Security: `update.chat.id` + `update.message_id` only tell us which
 * delivered copy was reacted to — they do NOT by themselves prove the
 * reactor is who they claim. We re-verify `mapping.recipientId ===
 * update.user.id` (the only account that could legitimately be reacting
 * inside that 1:1 chat with the bot) and that the chat session is still
 * active before mirroring anything.
 *
 * Requires `"message_reaction"` to be present in the webhook's
 * `allowed_updates` (see scripts/set-webhook.ts) or Telegram will never
 * deliver these updates at all.
 */
export function registerChatReactions(composer: Composer<NavaContext>) {
  composer.on("message_reaction", async (ctx) => {
    const update = ctx.messageReaction;
    if (!update || !update.user) return; // anonymous-channel-style reactions (update.actor_chat) are not supported here

    const mapping = await findRelayedMessage(update.chat.id, update.message_id);
    if (!mapping) return; // not a message we relayed (or TTL-expired) — nothing to mirror

    // Real authorization check: only the actual recipient of that delivered
    // copy can be the one reacting to it.
    if (mapping.recipientId !== update.user.id) return;

    const session = await getSession(mapping.sessionId);
    if (!session || !session.active) return; // chat ended — don't mirror reactions into a dead/reassigned session

    await ctx.api
      .setMessageReaction(mapping.senderId, mapping.senderMessageId, update.new_reaction)
      .catch(() => {
        // Sender may have deleted the message, blocked the bot, etc. —
        // silently drop, mirroring how relayed message delivery failures
        // are already handled elsewhere in chat.ts.
      });
  });
}
