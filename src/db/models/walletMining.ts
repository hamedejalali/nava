import { getDb } from "../connect.js";
import { randomUUID } from "node:crypto";

/** How many taps earn 1 whole Relic. Matches the Mini App's own visual
 *  "progress ring" constant (CLICKS_PER_RELIC in script.js) — keep these
 *  two in sync if you ever tune the mining rate. */
export const TAPS_PER_RELIC = 475;

/** Generous but real ceiling: a human tapping a screen cannot sustain much
 *  more than ~10 taps/sec for more than a moment. This blocks a script
 *  claiming "10,000 taps" in one batch while never penalizing a genuinely
 *  fast real tapper. */
const MAX_TAPS_PER_SECOND = 10;

interface MiningStateDoc {
  _id: number; // telegramId
  carryTaps: number; // taps banked toward the next whole Relic
  lastSyncAt: Date;
}

async function collection() {
  const db = await getDb();
  return db.collection<MiningStateDoc>("wallet_mining_state");
}

/**
 * Call with the number of taps the client claims happened since its last
 * sync. Returns how many whole Relic were actually credited (always
 * server-computed, never the client's own math). Idempotent per call is
 * NOT guaranteed by design (each call represents new taps), but the
 * server-side rate cap means a retried/duplicated call at worst costs the
 * user nothing extra (capped by elapsed real time either way).
 */
export async function creditMiningTaps(telegramId: number, claimedTaps: number): Promise<{ creditedRelic: number; newBalance: number }> {
  const col = await collection();
  const db = await getDb();
  const usersCol = db.collection<{ _id: number; relicBalance: number }>("users");
  const ledger = db.collection<any>("relic_transactions");

  const now = new Date();
  const state = await col.findOne({ _id: telegramId });
  const elapsedSeconds = state ? Math.max(0, (now.getTime() - state.lastSyncAt.getTime()) / 1000) : 0;
  const maxAllowedTaps = state ? Math.ceil(elapsedSeconds * MAX_TAPS_PER_SECOND) + 5 : Math.min(claimedTaps, 50);
  const acceptedTaps = Math.max(0, Math.min(claimedTaps, maxAllowedTaps));

  const totalTaps = (state?.carryTaps ?? 0) + acceptedTaps;
  const wholeRelic = Math.floor(totalTaps / TAPS_PER_RELIC);
  const remainderTaps = totalTaps % TAPS_PER_RELIC;

  await col.updateOne({ _id: telegramId }, { $set: { carryTaps: remainderTaps, lastSyncAt: now } }, { upsert: true });

  if (wholeRelic > 0) {
    await ledger.insertOne({
      _id: `mining:${telegramId}:${now.getTime()}:${randomUUID()}`,
      userId: telegramId,
      amount: wholeRelic,
      type: "WALLET_MINING",
      status: "completed",
      sourceApp: "wallet",
      createdAt: now,
      completedAt: now,
    });
    await usersCol.updateOne({ _id: telegramId }, { $inc: { relicBalance: wholeRelic } });
  }

  const user = await usersCol.findOne({ _id: telegramId }, { projection: { relicBalance: 1 } });
  return { creditedRelic: wholeRelic, newBalance: user?.relicBalance ?? 0 };
}
