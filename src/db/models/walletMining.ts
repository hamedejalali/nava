import { getClient, getDb } from "../connect.js";

/** How many taps earn 1 whole Relic. Matches the Mini App's own visual
 *  "progress ring" constant (CLICKS_PER_RELIC in script.js) — keep these
 *  two in sync if you ever tune the mining rate. */
export const TAPS_PER_RELIC = 475;

/** Generous but real ceiling: a human tapping a screen cannot sustain much
 *  more than ~10 taps/sec for more than a moment. This blocks a script
 *  claiming "10,000 taps" in one batch while never penalizing a genuinely
 *  fast real tapper. */
const MAX_TAPS_PER_SECOND = 10;

/** How long a processed batch's result is kept for delayed-retry lookups.
 *  A real network retry lands within seconds to at most a few minutes;
 *  24h is a generous safety margin (covers a phone going offline and
 *  reconnecting later) without keeping this collection growing forever. */
const BATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface MiningCreditResult {
  /** How many whole Relic this call credited (0 if the batch didn't cross
   *  a whole-Relic boundary yet). */
  creditedRelic: number;
  newBalance: number;
  /** How many of the CLAIMED taps were actually accepted (after the
   *  rate-limit cap). The frontend must only subtract THIS many from its
   *  local pending-taps counter. */
  acceptedTaps: number;
  /** True when this response is a replay of a previously processed batch,
   *  not a freshly-processed one. */
  duplicate: boolean;
}

interface MiningStateDoc {
  _id: number; // telegramId
  carryTaps: number; // taps banked toward the next whole Relic
  lastSyncAt: Date;
}

interface MiningBatchDoc {
  _id: string; // `${telegramId}:${batchId}` — the real idempotency guard
  telegramId: number;
  result: { creditedRelic: number; newBalance: number; acceptedTaps: number };
  createdAt: Date;
}

async function stateCollection() {
  const db = await getDb();
  return db.collection<MiningStateDoc>("wallet_mining_state");
}

async function batchCollection() {
  const db = await getDb();
  return db.collection<MiningBatchDoc>("wallet_mining_batches");
}

/** Marker used to abort the transaction cleanly when a genuinely
 *  concurrent duplicate insert of the SAME batch loses the race — caught
 *  outside and turned into a plain replay of the winner's result. */
class BatchAlreadyProcessedError extends Error {}

export async function ensureWalletMiningIndexes(): Promise<void> {
  const batches = await batchCollection();
  await batches.createIndexes([
    // `_id` is already unique by default — this TTL index only bounds
    // storage growth for a collection that otherwise gets one document
    // per sync call, forever, for every active miner.
    { key: { createdAt: 1 }, name: "createdAt_ttl", expireAfterSeconds: BATCH_RETENTION_MS / 1000 },
  ]);
}

/**
 * Call with the number of taps the client claims happened since its last
 * sync, and a `batchId` the client generated ONCE for this specific batch
 * (and must resend unchanged if it has to retry the same HTTP call — see
 * PREMIUM_WALLET/script.js). Returns exactly how many raw taps were
 * accepted and how much whole Relic that produced (always server-computed,
 * never the client's own math).
 *
 * FIXED (v1.5.0) — durable idempotency. The previous version only
 * remembered the MOST RECENT batchId (`lastBatchId`/`lastBatchResult` on
 * the mining-state document). That protects an immediate retry, but NOT
 * this real scenario: batch A succeeds, batch B succeeds (overwriting
 * "most recent"), then a DELAYED retry of batch A finally arrives — its id
 * no longer matches "the most recent one", so it would be treated as a
 * brand-new batch and could credit Relic a second time for taps already
 * paid out. Every processed batchId is now recorded PERMANENTLY (well,
 * for `BATCH_RETENTION_MS`) in its own collection
 * (`wallet_mining_batches`), keyed by `${telegramId}:${batchId}` with
 * MongoDB's own unique-`_id` constraint as the real guard — so ANY
 * batchId ever processed is protected, not just the latest one, and this
 * survives cold starts / restarts since it lives in MongoDB, not memory.
 *
 * Race-condition protection (v1.4.0) is unchanged: the whole
 * read -> compute -> write sequence still runs inside one MongoDB
 * transaction.
 */
export async function creditMiningTaps(telegramId: number, claimedTaps: number, batchId: string): Promise<MiningCreditResult> {
  const client = await getClient();
  const state = await stateCollection();
  const batches = await batchCollection();
  const db = await getDb();
  const usersCol = db.collection<{ _id: number; relicBalance: number }>("users");
  const ledger = db.collection<any>("relic_transactions");

  const batchKey = `${telegramId}:${batchId}`;

  // Fast path — this exact batch (from any point in the retention window,
  // not just "the last one") was already durably processed: no need to
  // even open a transaction.
  const existing = await batches.findOne({ _id: batchKey });
  if (existing) {
    return { ...existing.result, duplicate: true };
  }

  const session = client.startSession();
  let result!: MiningCreditResult;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const currentState = await state.findOne({ _id: telegramId }, { session });

      const elapsedSeconds = currentState ? Math.max(0, (now.getTime() - currentState.lastSyncAt.getTime()) / 1000) : 0;
      const maxAllowedTaps = currentState ? Math.ceil(elapsedSeconds * MAX_TAPS_PER_SECOND) + 5 : Math.min(claimedTaps, 50);
      const acceptedTaps = Math.max(0, Math.min(claimedTaps, maxAllowedTaps));

      const totalTaps = (currentState?.carryTaps ?? 0) + acceptedTaps;
      const wholeRelic = Math.floor(totalTaps / TAPS_PER_RELIC);
      const remainderTaps = totalTaps % TAPS_PER_RELIC;

      if (wholeRelic > 0) {
        await ledger.insertOne(
          {
            _id: `mining:${batchKey}`,
            userId: telegramId,
            amount: wholeRelic,
            type: "WALLET_MINING",
            status: "completed",
            sourceApp: "wallet",
            createdAt: now,
            completedAt: now,
          },
          { session }
        );
        await usersCol.updateOne({ _id: telegramId }, { $inc: { relicBalance: wholeRelic } }, { session });
      }

      const user = await usersCol.findOne({ _id: telegramId }, { projection: { relicBalance: 1 }, session });
      const batchResult = { creditedRelic: wholeRelic, newBalance: user?.relicBalance ?? 0, acceptedTaps };

      await state.updateOne({ _id: telegramId }, { $set: { carryTaps: remainderTaps, lastSyncAt: now } }, { upsert: true, session });

      try {
        await batches.insertOne({ _id: batchKey, telegramId, result: batchResult, createdAt: now }, { session });
      } catch (err: any) {
        // A genuinely concurrent duplicate call for this exact batch lost
        // the race to commit — MongoDB's unique `_id` is the final guard.
        // Aborting here discards THIS transaction's speculative
        // ledger/balance writes above; the winner's writes are the only
        // ones that actually persist.
        if (err?.code === 11000) throw new BatchAlreadyProcessedError();
        throw err;
      }

      result = { ...batchResult, duplicate: false };
    });
  } catch (err) {
    if (err instanceof BatchAlreadyProcessedError) {
      const winner = await batches.findOne({ _id: batchKey });
      if (!winner) throw err; // should be unreachable — don't silently swallow if it somehow is
      result = { ...winner.result, duplicate: true };
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }

  return result;
}
