import { getClient, getDb } from "../../db/connect.js";
import {
  buildCandidateQuery,
  SEARCH_TIMEOUT_MS,
  type MatchQueueDoc,
  type SearchType,
} from "../../db/models/matchQueue.js";
import { newSessionId, type ChatSessionDoc } from "../../db/models/chatSession.js";
import type { UserDoc } from "../../db/models/user.js";
import { chargeChatCost, InsufficientBalanceError } from "../../db/models/relic.js";

export type MatchAttemptResult =
  | { status: "matched"; sessionId: string; partnerId: number; partnerStatusMessageId?: number }
  | { status: "queued" };

/**
 * Attempts to find a compatible waiting user and, if found, atomically:
 *  - removes the candidate's queue entry
 *  - removes the searcher's own (possibly stale) queue entry, if any
 *  - creates the chat session
 *  - marks both users as actively in that session
 *
 * If no candidate is available, atomically inserts/refreshes the
 * searcher's own queue entry instead. Everything happens inside a single
 * MongoDB transaction so two concurrent searches can never both "win" the
 * same candidate, and a match can never be created without both users'
 * queue entries being cleaned up in the same atomic step.
 */
export async function attemptMatchOrQueue(user: UserDoc, searchType: SearchType, statusMessageId: number | undefined): Promise<MatchAttemptResult> {
  const client = await getClient();
  const db = await getDb();
  const usersCol = db.collection<UserDoc>("users");
  const queueCol = db.collection<MatchQueueDoc>("match_queue");
  const sessionsCol = db.collection<ChatSessionDoc>("chat_sessions");

  const query = buildCandidateQuery({
    telegramId: user._id,
    searchType,
    gender: user.gender!,
    age: user.age!,
    province: user.province,
  });

  const mongoSession = client.startSession();
  try {
    let result: MatchAttemptResult = { status: "queued" };

    try {
      await mongoSession.withTransaction(async () => {
        const candidate = await queueCol.findOneAndDelete(query, { session: mongoSession });

        if (!candidate) {
          // No one compatible is waiting right now — take our place in line.
          await queueCol.updateOne(
            { _id: user._id },
            {
              $set: {
                _id: user._id,
                searchType,
                genderSnapshot: user.gender!,
                ageSnapshot: user.age!,
                provinceSnapshot: user.province,
                statusMessageId,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + SEARCH_TIMEOUT_MS),
              },
            },
            { upsert: true, session: mongoSession }
          );
          result = { status: "queued" };
          return;
        }

        // Found a compatible candidate — clean up our own stale entry (if
        // any) and create the session.
        await queueCol.deleteOne({ _id: user._id }, { session: mongoSession });

        const sessionId = newSessionId();

        // Both users pay 1 Relic for a successful connection, atomically
        // with match creation. If either can't afford it, this throws and
        // the whole transaction (including the candidate deletion above)
        // rolls back — attemptMatchOrQueue's caller falls back to queuing
        // the searcher instead of a partially-broken match.
        await chargeChatCost(user._id, sessionId, usersCol, mongoSession);
        await chargeChatCost(candidate._id, sessionId, usersCol, mongoSession);

        const session: ChatSessionDoc = {
          _id: sessionId,
          userA: user._id,
          userB: candidate._id,
          active: true,
          createdAt: new Date(),
        };
        await sessionsCol.insertOne(session, { session: mongoSession });

        await usersCol.updateOne({ _id: user._id }, { $set: { activeChatSessionId: sessionId } }, { session: mongoSession });
        await usersCol.updateOne({ _id: candidate._id }, { $set: { activeChatSessionId: sessionId } }, { session: mongoSession });

        result = { status: "matched", sessionId, partnerId: candidate._id, partnerStatusMessageId: candidate.statusMessageId };
      });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        // Rolled back cleanly (candidate's queue entry is restored). Fall
        // back to simply queuing the searcher, outside any transaction.
        await queueCol.updateOne(
          { _id: user._id },
          {
            $set: {
              _id: user._id,
              searchType,
              genderSnapshot: user.gender!,
              ageSnapshot: user.age!,
              provinceSnapshot: user.province,
              statusMessageId,
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + SEARCH_TIMEOUT_MS),
            },
          },
          { upsert: true }
        );
        return { status: "queued" };
      }
      throw err;
    }

    return result;
  } finally {
    await mongoSession.endSession();
  }
}
