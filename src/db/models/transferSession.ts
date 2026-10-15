import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export interface TransferSessionDoc {
  _id: number; // senderId — one pending transfer flow per user
  targetId: number;
  /** identifies THIS transfer flow; the money operation id is derived from it, so a double tap on "confirm" is one transfer */
  flowId?: string;
  amount?: number; // set once the amount has been entered, before confirmation
  promptMessageId?: number;
  createdAt: Date;
}

async function col(): Promise<Collection<TransferSessionDoc>> {
  const db = await getDb();
  return db.collection<TransferSessionDoc>("relic_transfer_sessions");
}

export async function startTransferSession(senderId: number, targetId: number): Promise<void> {
  await (await col()).updateOne({ _id: senderId }, { $set: { targetId, createdAt: new Date(), flowId: randomUUID() }, $unset: { amount: "" } }, { upsert: true });
}

export async function setTransferAmount(senderId: number, amount: number, promptMessageId: number): Promise<void> {
  await (await col()).updateOne({ _id: senderId }, { $set: { amount, promptMessageId } });
}

export async function getTransferSession(senderId: number): Promise<TransferSessionDoc | null> {
  return (await col()).findOne({ _id: senderId });
}

export async function clearTransferSession(senderId: number): Promise<void> {
  await (await col()).deleteOne({ _id: senderId });
}

/** Stable id of the transfer operation: same flow => same id (a duplicate tap is recognised), a new flow => new id.
 *  Sessions created before v1.16.3 have no flowId; their creation time identifies them. */
export function transferOperationId(senderId: number, session: TransferSessionDoc): string {
  return `${senderId}:${session.flowId ?? session.createdAt.getTime()}`;
}
