import { getDb } from "../connect.js";
import { runInTransaction } from "../tx.js";
import { refundChatCostInSession } from "./relic.js";
import type { ChatSessionDoc } from "./chatSession.js";
import { isSeedId } from "../../services/seeds/ids.js";

export type CloseResult =
  | { status: "ended"; session: ChatSessionDoc; refunded: number[] }
  | { status: "already_ended" };

/**
 * Ends a chat session as ONE MongoDB transaction: mark it ended, free both participants (only if they still
 * point at THIS session) and pay the chosen refunds. Either everything happens or nothing does, so a
 * database failure in the middle can no longer leave "session ended but refund missing / user still stuck":
 * the whole thing rolls back, the session stays active, and the caller can simply try again. A repeat call
 * after success finds the session already ended and does nothing (refund ledger ids are deterministic, so
 * nobody can be credited twice either way).
 *
 * `refundFor(session)` decides, from the session as it is when it ends (e.g. its message count), who gets
 * their 1 Relic chat cost back.
 */
export async function closeSessionAtomic(
  sessionId: string,
  endedBy: number,
  refundFor: (session: ChatSessionDoc) => number[],
  reason: "user_end" | "undelivered" | "banned" = "user_end",
): Promise<CloseResult> {
  const db = await getDb();
  const sessions = db.collection<ChatSessionDoc>("chat_sessions");
  const users = db.collection<any>("users");

  return runInTransaction(async (session): Promise<CloseResult> => {
    const ended = await sessions.findOneAndUpdate(
      { _id: sessionId, active: true },
      { $set: { active: false, endedAt: new Date(), endedBy, endReason: reason } },
      { returnDocument: "after", session },
    );
    if (!ended) return { status: "already_ended" };

    for (const id of [ended.userA, ended.userB]) {
      await users.updateOne({ _id: id, activeChatSessionId: sessionId }, { $set: { activeChatSessionId: null } }, { session });
    }
    const refunded: number[] = [];
    for (const id of new Set(refundFor(ended))) {
      // default (seed) members have no Relic and a chat with one is free: never refund/credit them
      if (isSeedId(id) || ended.seedChat) continue;
      if (await refundChatCostInSession(id, sessionId, session)) refunded.push(id);
    }
    return { status: "ended", session: ended, refunded };
  });
}
