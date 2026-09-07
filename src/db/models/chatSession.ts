import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export interface ChatSessionDoc {
  _id: string; // opaque session id, never exposed to users
  userA: number;
  userB: number;
  active: boolean;
  createdAt: Date;
  endedAt?: Date;
  endedBy?: number; // telegramId of whoever pressed "پایان چت"
  /** Guards the 1-Relic cashback (Feature "CHAT REFUND") against being
   *  awarded twice because of duplicate Telegram updates/retries. */
  cashbackIssued?: boolean;
}

async function sessionCollection(): Promise<Collection<ChatSessionDoc>> {
  const db = await getDb();
  return db.collection<ChatSessionDoc>("chat_sessions");
}

export async function ensureChatSessionIndexes(): Promise<void> {
  const col = await sessionCollection();
  await col.createIndexes([
    { key: { userA: 1 }, name: "userA_1" },
    { key: { userB: 1 }, name: "userB_1" },
  ]);
}

export function newSessionId(): string {
  return randomUUID();
}

export async function getSession(sessionId: string): Promise<ChatSessionDoc | null> {
  const col = await sessionCollection();
  return col.findOne({ _id: sessionId });
}

/** Returns the other participant's telegramId, or null if `telegramId` is
 *  not actually part of this session (never trust a client-supplied id). */
export function otherParticipant(session: ChatSessionDoc, telegramId: number): number | null {
  if (session.userA === telegramId) return session.userB;
  if (session.userB === telegramId) return session.userA;
  return null;
}

export type EndChatResult = { status: "ended"; session: ChatSessionDoc } | { status: "already_ended" };

/** Atomically closes a session — the filter requires `active: true`, so a
 *  duplicate/concurrent "پایان چت" tap (from either side) can only ever
 *  succeed once. */
export async function endSessionOnce(sessionId: string, endedBy: number): Promise<EndChatResult> {
  const col = await sessionCollection();
  const updated = await col.findOneAndUpdate(
    { _id: sessionId, active: true },
    { $set: { active: false, endedAt: new Date(), endedBy } },
    { returnDocument: "after" }
  );
  if (updated) return { status: "ended", session: updated };
  return { status: "already_ended" };
}

/** Idempotently marks the cashback as issued for a session — returns true
 *  only the first time (safe to call from a retried/duplicate update). */
export async function markCashbackIssued(sessionId: string): Promise<boolean> {
  const col = await sessionCollection();
  const updated = await col.findOneAndUpdate(
    { _id: sessionId, cashbackIssued: { $ne: true } },
    { $set: { cashbackIssued: true } },
    { returnDocument: "after" }
  );
  return !!updated;
}
