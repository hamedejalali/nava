import { getDb } from "../connect.js";

interface BlockDoc {
  _id: string; // `${blockerId}:${blockedId}`
  blockerId: number;
  blockedId: number;
  createdAt: Date;
}

async function collection() {
  const db = await getDb();
  return db.collection<BlockDoc>("blocks");
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
