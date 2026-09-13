import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export type EditRequestField = "nickname" | "age";
export type EditRequestStatus = "pending" | "approved" | "rejected";

export interface EditRequestDoc {
  _id: string;
  telegramId: number;
  field: EditRequestField;
  oldValue: string;
  newValue: string;
  status: EditRequestStatus;
  createdAt: Date;
  decidedAt?: Date;
  decidedBy?: number;
}

async function collection(): Promise<Collection<EditRequestDoc>> {
  const db = await getDb();
  return db.collection<EditRequestDoc>("edit_requests");
}

export async function createEditRequest(
  telegramId: number,
  field: EditRequestField,
  oldValue: string,
  newValue: string
): Promise<EditRequestDoc> {
  const doc: EditRequestDoc = {
    _id: randomUUID(),
    telegramId,
    field,
    oldValue,
    newValue,
    status: "pending",
    createdAt: new Date(),
  };
  const col = await collection();
  await col.insertOne(doc);
  return doc;
}

export async function getEditRequest(id: string): Promise<EditRequestDoc | null> {
  const col = await collection();
  return col.findOne({ _id: id });
}

/** Atomically transitions a still-pending request — so two admins tapping
 *  Approve/Reject on the same request at nearly the same instant can never
 *  both "win". Returns null if it was already decided. */
export async function decideEditRequest(id: string, status: "approved" | "rejected", decidedBy: number): Promise<EditRequestDoc | null> {
  const col = await collection();
  return col.findOneAndUpdate(
    { _id: id, status: "pending" },
    { $set: { status, decidedAt: new Date(), decidedBy } },
    { returnDocument: "after" }
  );
}
