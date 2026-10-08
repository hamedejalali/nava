import { getDb } from "../connect.js";
import { TAPS_PER_RELIC, isWalletOwner, accounts, getOrCreateAccount, getSupply, insertLedger, issueFromSupply, runTx } from "./walletCore.js";
import { gateFor, type TaskView } from "./walletTasks.js";

export { TAPS_PER_RELIC };

/** Generous but real ceiling: a human cannot sustain much more than ~10 taps/sec. */
const MAX_TAPS_PER_SECOND = 10;
/** How long a processed batch's result is kept for delayed-retry lookups. */
const BATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface MiningCreditResult {
  /** Whole Relic credited by this call. */
  creditedRelic: number;
  /** WALLET balance after this call (v1.11.0: the wallet has its own balance, separate from Nava). */
  newBalance: number;
  acceptedTaps: number;
  /** Taps banked toward the next whole Relic (display = balance + carryTaps/TAPS_PER_RELIC). */
  carryTaps: number;
  supplyExhausted: boolean;
  gate: { blocked: boolean; task: TaskView | null };
  duplicate: boolean;
}

interface MiningStateDoc { _id: number; carryTaps: number; lastSyncAt: Date }
interface MiningBatchDoc {
  _id: string; // `${telegramId}:${batchId}`
  telegramId: number;
  result: Omit<MiningCreditResult, "duplicate" | "gate">;
  createdAt: Date;
}

async function stateCollection() { return (await getDb()).collection<MiningStateDoc>("wallet_mining_state"); }
async function batchCollection() { return (await getDb()).collection<MiningBatchDoc>("wallet_mining_batches"); }

class BatchAlreadyProcessedError extends Error {}

export async function ensureWalletMiningIndexes(): Promise<void> {
  const batches = await batchCollection();
  await batches.createIndexes([{ key: { createdAt: 1 }, name: "createdAt_ttl", expireAfterSeconds: BATCH_RETENTION_MS / 1000 }]);
}

/**
 * Credits mined Relic to the user's WALLET account (never to Nava's balance).
 *  - exactly-once per (user,batchId): the batch row is inserted in the same transaction;
 *  - tap-rate cap server side;
 *  - mining gate: taps beyond a gate threshold are not accepted until the gate task is done;
 *  - supply cap: Relic only comes out of the finite `remaining` supply.
 */
export async function creditMiningTaps(telegramId: number, claimedTaps: number, batchId: string): Promise<MiningCreditResult> {
  const state = await stateCollection();
  const batches = await batchCollection();
  const batchKey = `${telegramId}:${batchId}`;

  const acct0 = await getOrCreateAccount(telegramId);
  const withGate = async (r: Omit<MiningCreditResult, "duplicate" | "gate">, duplicate: boolean): Promise<MiningCreditResult> => {
    const a = await getOrCreateAccount(telegramId);
    const g = await gateFor(telegramId, a.tapsTotal);
    return { ...r, gate: { blocked: g.blocked, task: g.task }, duplicate };
  };

  // The owner already holds the whole undistributed supply: tapping would only move Relic from the owner to the owner.
  if (isWalletOwner(telegramId)) {
    return withGate({ creditedRelic: 0, newBalance: acct0.balance, acceptedTaps: Math.max(0, Math.floor(claimedTaps)), carryTaps: 0, supplyExhausted: false }, false);
  }

  const existing = await batches.findOne({ _id: batchKey });
  if (existing) return withGate(existing.result, true);

  const gateNow = await gateFor(telegramId, acct0.tapsTotal);

  let result!: Omit<MiningCreditResult, "duplicate" | "gate">;
  try {
    await runTx(async (session) => {
      const now = new Date();
      const accts = await accounts();
      const currentState = await state.findOne({ _id: telegramId }, { session });

      const elapsedSeconds = currentState ? Math.max(0, (now.getTime() - currentState.lastSyncAt.getTime()) / 1000) : 0;
      const maxAllowedTaps = currentState ? Math.ceil(elapsedSeconds * MAX_TAPS_PER_SECOND) + 5 : Math.min(claimedTaps, 50);
      let acceptedTaps = Math.max(0, Math.min(claimedTaps, maxAllowedTaps));
      if (Number.isFinite(gateNow.allowedTaps)) acceptedTaps = Math.min(acceptedTaps, gateNow.allowedTaps);

      const totalTaps = (currentState?.carryTaps ?? 0) + acceptedTaps;
      let wholeRelic = Math.floor(totalTaps / TAPS_PER_RELIC);
      let supplyExhausted = false;
      if (wholeRelic > 0) {
        const supply = await getSupply();
        if (supply.remaining < wholeRelic) {
          wholeRelic = Math.max(0, supply.remaining);
          supplyExhausted = true;
        }
      }
      // taps that could not be paid stay banked (never discarded), but cap the bank so it can't grow unbounded
      const carry = Math.min(totalTaps - wholeRelic * TAPS_PER_RELIC, TAPS_PER_RELIC * 2 - 1);

      if (wholeRelic > 0) {
        await issueFromSupply(wholeRelic, session);
        await insertLedger({ _id: `mining:${batchKey}`, kind: "mining", amount: wholeRelic, fromUser: null, toUser: telegramId, from: "supply", to: `wallet:${telegramId}` }, session);
      }
      await accts.updateOne({ _id: telegramId }, { $inc: { balance: wholeRelic, tapsTotal: acceptedTaps } }, { session });
      const fresh = await accts.findOne({ _id: telegramId }, { session });

      await state.updateOne({ _id: telegramId }, { $set: { carryTaps: carry, lastSyncAt: now } }, { upsert: true, session });

      result = { creditedRelic: wholeRelic, newBalance: fresh?.balance ?? 0, acceptedTaps, carryTaps: carry, supplyExhausted };
      try {
        await batches.insertOne({ _id: batchKey, telegramId, result, createdAt: now }, { session });
      } catch (err: any) {
        if (err?.code === 11000) throw new BatchAlreadyProcessedError();
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof BatchAlreadyProcessedError) {
      const winner = await batches.findOne({ _id: batchKey });
      if (!winner) throw err;
      return withGate(winner.result, true);
    }
    throw err;
  }
  return withGate(result, false);
}

export async function getMiningCarry(telegramId: number): Promise<number> {
  const s = await (await stateCollection()).findOne({ _id: telegramId });
  return s?.carryTaps ?? 0;
}
