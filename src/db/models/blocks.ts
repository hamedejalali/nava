import { getDb } from "../connect.js";
import type { Collection } from "mongodb";

interface BlockDoc {
  _id: string; // `${blockerId}:${blockedId}`
  blockerId: number;
  blockedId: number;
  createdAt: Date;
}

async function collection(): Promise<Collection<BlockDoc>> {
  const db = await getDb();
  return db.collection<BlockDoc>("blocks");
}

// FIXED (v1.4.0, audit): this collection had NO indexes beyond the
// default one on `_id` — but `_id` is `${blockerId}:${blockedId}`, one
// specific direction, while every real query here (`isBlockedEitherWay`,
// and especially `getBlockedCounterparts`, which the matching engine
// calls on every single search to build its exclusion list — a genuinely
// hot path, unlike most other collections audited here) filters by the
// bare `blockerId`/`blockedId` fields in both directions. Every call was
// a full collection scan. Two single-field indexes let MongoDB use an
// index for both sides of every `$or` in this file.
export async function ensureBlocksIndexes(): Promise<void> {
  const col = await collection();
  await col.createIndexes([
    { key: { blockerId: 1 }, name: "blockerId_1" },
    { key: { blockedId: 1 }, name: "blockedId_1" },
  ]);
}

export async function blockUser(blockerId: number, blockedId: number): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { _id: `${blockerId}:${blockedId}` },
    { $setOnInsert: { blockerId, blockedId, createdAt: new Date() } },
    { upsert: true }
  );
}

export async function unblockUser(blockerId: number, blockedId: number): Promise<void> {
  const col = await collection();
  await col.deleteOne({ _id: `${blockerId}:${blockedId}` });
}

/** True if EITHER side has blocked the other — a block is always mutual
 *  in effect (neither can be matched with or message the other again),
 *  even though only one side took the action. */
export async function isBlockedEitherWay(userA: number, userB: number): Promise<boolean> {
  const col = await collection();
  const found = await col.findOne({
    $or: [
      { blockerId: userA, blockedId: userB },
      { blockerId: userB, blockedId: userA },
    ],
  });
  return !!found;
}

/** All user ids that `userId` must never be matched with — either
 *  direction of a block. Used to build the matching engine's exclusion
 *  list in one query instead of one isBlockedEitherWay() call per
 *  candidate. */
export async function getBlockedCounterparts(userId: number): Promise<number[]> {
  const col = await collection();
  const docs = await col.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).toArray();
  return docs.map((d) => (d.blockerId === userId ? d.blockedId : d.blockerId));
}
