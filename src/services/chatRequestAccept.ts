import { getClient, getDb } from "../db/connect.js";
import { newSessionId, type ChatSessionDoc } from "../db/models/chatSession.js";
import { chargeChatCost, InsufficientBalanceError } from "../db/models/relic.js";
import type { UserDoc } from "../db/models/user.js";
import type { ChatRequestDoc } from "../db/models/chatRequest.js";
import { isBlockedEitherWay } from "../db/models/blocks.js";

export type AcceptResult =
  | { status: "accepted"; sessionId: string; fromId: number; toId: number }
  | { status: "not_pending" } // already answered / expired / not addressed to this user
  | { status: "busy" } // somebody is already in another chat
  | { status: "blocked" }
  | { status: "insufficient"; userId: number };

class Abort extends Error {
  constructor(public result: AcceptResult) {
    super("abort");
  }
}

/**
 * Accepts a chat request. Everything happens in ONE MongoDB transaction:
 *  1. the request is claimed (pending -> accepted) — a duplicate tap or a
 *     retried Telegram update finds it no longer pending and does nothing,
 *  2. both users must be free and not banned,
 *  3. both are charged 1 Relic (same ledger rows as a normal match, so the
 *     existing refund-on-short-chat logic keeps working),
 *  4. the chat session is created and both users are pointed at it.
 * If any step fails the whole transaction (including the claim) rolls back.
 */
export async function acceptChatRequest(token: string, acceptorId: number, now = new Date()): Promise<AcceptResult> {
  const client = await getClient();
  const db = await getDb();
  const requests = db.collection<ChatRequestDoc>("chat_requests");
  const users = db.collection<UserDoc>("users");
  const sessions = db.collection<ChatSessionDoc>("chat_sessions");
  const queue = db.collection<any>("match_queue");

  if (await requestIsUnavailable(requests, token, acceptorId, now)) return { status: "not_pending" };

  const mongoSession = client.startSession();
  try {
    let result: AcceptResult = { status: "not_pending" };
    try {
      await mongoSession.withTransaction(async () => {
        const claimed = await requests.findOneAndUpdate(
          { _id: token, toId: acceptorId, status: "pending", expiresAt: { $gt: now } },
          { $set: { status: "accepted", respondedAt: now } },
          { returnDocument: "after", session: mongoSession }
        );
        if (!claimed) throw new Abort({ status: "not_pending" });

        const { fromId, toId } = claimed;
        if (await isBlockedEitherWay(fromId, toId)) throw new Abort({ status: "blocked" });

        const sessionId = newSessionId();

        // Mark both users busy FIRST, with a guard that fails if either is
        // already in a chat (or banned) — this is what makes two requests
        // accepted at the same moment unable to put one user in two chats.
        for (const id of [fromId, toId]) {
          const marked = await users.updateOne(
            { _id: id, banned: { $ne: true }, activeChatSessionId: null as any },
            { $set: { activeChatSessionId: sessionId } },
            { session: mongoSession }
          );
          if (marked.matchedCount !== 1) throw new Abort({ status: "busy" });
        }

        try {
          await chargeChatCost(fromId, sessionId, users as any, mongoSession);
          await chargeChatCost(toId, sessionId, users as any, mongoSession);
        } catch (err) {
          if (err instanceof InsufficientBalanceError) throw new Abort({ status: "insufficient", userId: err.userId });
          throw err;
        }

        await sessions.insertOne(
          { _id: sessionId, userA: fromId, userB: toId, active: true, createdAt: now },
          { session: mongoSession }
        );
        await requests.updateOne({ _id: token }, { $set: { sessionId } }, { session: mongoSession });
        // neither user should still be waiting in the random-search queue
        await queue.deleteMany({ _id: { $in: [fromId, toId] } }, { session: mongoSession });

        result = { status: "accepted", sessionId, fromId, toId };
      });
    } catch (err) {
      if (err instanceof Abort) return err.result;
      throw err;
    }
    return result;
  } finally {
    await mongoSession.endSession();
  }
}

async function requestIsUnavailable(requests: any, token: string, acceptorId: number, now: Date): Promise<boolean> {
  const doc = await requests.findOne({ _id: token, toId: acceptorId });
  if (!doc || doc.status !== "pending") return true;
  if (doc.expiresAt <= now) {
    await requests.updateOne({ _id: token, status: "pending" }, { $set: { status: "expired", respondedAt: now } });
    return true;
  }
  return false;
}
