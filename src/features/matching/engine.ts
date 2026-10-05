import type { ClientSession } from "mongodb";
import { getClient, getDb } from "../../db/connect.js";
import { buildCandidateQuery, SEARCH_TIMEOUT_MS, type MatchQueueDoc, type SearchType } from "../../db/models/matchQueue.js";
import { newSessionId, type ChatSessionDoc } from "../../db/models/chatSession.js";
import type { UserDoc } from "../../db/models/user.js";
import { chargeChatCost, InsufficientBalanceError } from "../../db/models/relic.js";
import { getBlockedCounterparts } from "../../db/models/blocks.js";

export type MatchAttemptResult =
  | { status: "matched"; sessionId: string; partnerId: number; partnerStatusMessageId?: number }
  | { status: "queued" }
  /** Someone else's invocation matched THIS user while they were being queued; that invocation notifies both. */
  | { status: "matched_elsewhere" };

// internal control-flow markers (abort the transaction => everything it wrote is rolled back)
class NoCandidate extends Error {}
class OwnEntryGone extends Error {}
class Contended extends Error {}
class BrokenCandidate extends Error {
  constructor(public candidateId: number) {
    super("broken candidate");
  }
}

function queueDoc(user: UserDoc, searchType: SearchType, statusMessageId: number | undefined): Omit<MatchQueueDoc, "_id"> {
  const now = Date.now();
  return {
    searchType,
    genderSnapshot: user.gender!,
    ageSnapshot: user.age!,
    provinceSnapshot: user.province,
    statusMessageId,
    createdAt: new Date(now),
    expiresAt: new Date(now + SEARCH_TIMEOUT_MS),
  } as Omit<MatchQueueDoc, "_id">;
}

/**
 * One atomic match attempt.
 *  - finds a compatible waiting user;
 *  - removes the queue entries IN ASCENDING _id ORDER (a fixed order means two users who find each other at
 *    the same instant contend on the same first document, so exactly one transaction wins instead of both
 *    deleting "their own" entry and then conflicting on the other's);
 *  - charges both, creates the session, marks both active.
 * `requireOwnEntry` (used after the searcher already queued): the searcher's own entry must still be there,
 * otherwise somebody else already matched us and we must not create a second session.
 */
async function tryMatchOnce(user: UserDoc, searchType: SearchType, excludeIds: number[], requireOwnEntry: boolean): Promise<MatchAttemptResult | "none" | "gone"> {
  const client = await getClient();
  const db = await getDb();
  const usersCol = db.collection<UserDoc>("users");
  const queueCol = db.collection<MatchQueueDoc>("match_queue");
  const sessionsCol = db.collection<ChatSessionDoc>("chat_sessions");

  const query = buildCandidateQuery({ telegramId: user._id, searchType, gender: user.gender!, age: user.age!, province: user.province, excludeIds });
  const mongoSession: ClientSession = client.startSession();
  try {
    let result: MatchAttemptResult | null = null;
    try {
      await mongoSession.withTransaction(async () => {
        const candidate = await queueCol.findOne(query, { session: mongoSession });
        if (!candidate) throw new NoCandidate();

        const ids = [user._id, candidate._id].sort((a, b) => a - b);
        for (const id of ids) {
          const isOwn = id === user._id;
          const r = await queueCol.deleteOne(isOwn ? { _id: id } : { _id: id, expiresAt: { $gt: new Date() } }, { session: mongoSession });
          if (r.deletedCount !== 1) {
            if (isOwn) {
              if (requireOwnEntry) throw new OwnEntryGone();
            } else {
              throw new Contended(); // somebody else took the candidate first — look again
            }
          }
        }

        const sessionId = newSessionId();
        try {
          await chargeChatCost(user._id, sessionId, usersCol, mongoSession);
        } catch (err) {
          if (err instanceof InsufficientBalanceError) throw err; // the searcher cannot pay
          throw err;
        }
        try {
          await chargeChatCost(candidate._id, sessionId, usersCol, mongoSession);
        } catch (err) {
          if (err instanceof InsufficientBalanceError) throw new BrokenCandidate(candidate._id);
          throw err;
        }

        const session: ChatSessionDoc = { _id: sessionId, userA: user._id, userB: candidate._id, active: true, createdAt: new Date() };
        await sessionsCol.insertOne(session, { session: mongoSession });
        await usersCol.updateOne({ _id: user._id }, { $set: { activeChatSessionId: sessionId } }, { session: mongoSession });
        await usersCol.updateOne({ _id: candidate._id }, { $set: { activeChatSessionId: sessionId } }, { session: mongoSession });

        result = { status: "matched", sessionId, partnerId: candidate._id, partnerStatusMessageId: candidate.statusMessageId };
      });
    } catch (err) {
      if (err instanceof NoCandidate) return "none";
      if (err instanceof OwnEntryGone) return "gone";
      if (err instanceof Contended) return "none-retry" as never;
      if (err instanceof BrokenCandidate) {
        // A waiting user who can no longer pay would otherwise be picked first by EVERY newcomer and block
        // all matches. Drop their stale entry (rolled back with the transaction, so delete it now) and retry.
        await queueCol.deleteOne({ _id: err.candidateId });
        return "none-retry" as never;
      }
      throw err;
    }
    return result ?? "none";
  } finally {
    await mongoSession.endSession();
  }
}

async function matchLoop(user: UserDoc, searchType: SearchType, requireOwnEntry: boolean): Promise<MatchAttemptResult | "none" | "gone"> {
  const excludeIds = await getBlockedCounterparts(user._id);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await tryMatchOnce(user, searchType, excludeIds, requireOwnEntry);
    if ((r as unknown) === "none-retry") continue;
    return r;
  }
  return "none";
}

async function enqueue(user: UserDoc, searchType: SearchType, statusMessageId: number | undefined): Promise<void> {
  const db = await getDb();
  const queueCol = db.collection<MatchQueueDoc>("match_queue");
  await queueCol.updateOne({ _id: user._id }, { $set: queueDoc(user, searchType, statusMessageId) }, { upsert: true });
}

/**
 * Find a compatible waiting user and match atomically; otherwise take a place in the queue and then look
 * ONCE MORE. The second look closes the classic race: A and B search at the same moment, each sees an empty
 * queue, both enqueue, and neither would ever notice the other. After enqueuing, every searcher re-scans;
 * the ordered deletes in tryMatchOnce guarantee exactly one of them creates the session.
 */
export async function attemptMatchOrQueue(user: UserDoc, searchType: SearchType, statusMessageId: number | undefined): Promise<MatchAttemptResult> {
  let first: MatchAttemptResult | "none" | "gone" = "none";
  try {
    first = await matchLoop(user, searchType, false);
  } catch (err) {
    if (!(err instanceof InsufficientBalanceError)) throw err; // searcher cannot pay: just queue (same as before)
  }
  if (typeof first === "object") return first;

  await enqueue(user, searchType, statusMessageId);
  return rescanQueued(user, searchType);
}

/** Re-scan for a user who is ALREADY queued (used right after enqueuing and periodically during the countdown). */
export async function rescanQueued(user: UserDoc, searchType: SearchType): Promise<MatchAttemptResult> {
  let r: MatchAttemptResult | "none" | "gone";
  try {
    r = await matchLoop(user, searchType, true);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return { status: "queued" }; // searcher cannot pay now; stays queued until timeout
    throw err;
  }
  if (r === "gone") return { status: "matched_elsewhere" };
  if (r === "none") {
    // No partner right now. If our own entry has vanished, somebody else's transaction matched us.
    const db = await getDb();
    const stillThere = await db.collection<any>("match_queue").countDocuments({ _id: user._id });
    return stillThere ? { status: "queued" } : { status: "matched_elsewhere" };
  }
  return r;
}
