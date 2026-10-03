import type { Collection } from "mongodb";
import { getDb } from "../connect.js";

/**
 * Maps a message as it was DELIVERED to the recipient (their chat id +
 * message id) back to the original sender's own copy of that message.
 *
 * Purpose: real Telegram message reactions (`message_reaction` updates)
 * only tell us which message the REACTOR reacted to — we then need to find
 * the matching message in the ORIGINAL SENDER's chat so we can mirror the
 * reaction there via `setMessageReaction`. This is the only reason this
 * collection exists.
 *
 * Deliberately stores ONLY message-id pairs + the session/sender/recipient
 * ids — never any message content — and is short-lived (TTL index), per
 * the "no permanent chat-content storage" requirement.
 */
export interface ChatRelayMapDoc {
  /** `${recipientTelegramId}:${recipientMessageId}` — unique per delivered
   *  copy, and exactly what a message_reaction update gives us to look up. */
  _id: string;
  sessionId: string;
  senderId: number;
  senderMessageId: number;
  recipientId: number;
  recipientMessageId: number;
  createdAt: Date;
}

async function col(): Promise<Collection<ChatRelayMapDoc>> {
  const db = await getDb();
  return db.collection<ChatRelayMapDoc>("chat_relay_map");
}

export async function ensureChatRelayMapIndexes(): Promise<void> {
  const c = await col();
  // 30-day TTL — plenty for any realistic reaction mirroring window, and
  // bounds collection growth automatically without a cron job.
  await c.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
}

function mapId(recipientId: number, recipientMessageId: number): string {
  return `${recipientId}:${recipientMessageId}`;
}

export async function recordRelayedMessage(input: {
  sessionId: string;
  senderId: number;
  senderMessageId: number;
  recipientId: number;
  recipientMessageId: number;
}): Promise<void> {
  const c = await col();
  const _id = mapId(input.recipientId, input.recipientMessageId);
  await c.updateOne(
    { _id },
    { $setOnInsert: { ...input, _id, createdAt: new Date() } },
    { upsert: true }
  );
}

export async function findRelayedMessage(recipientId: number, recipientMessageId: number): Promise<ChatRelayMapDoc | null> {
  const c = await col();
  return c.findOne({ _id: mapId(recipientId, recipientMessageId) });
}
