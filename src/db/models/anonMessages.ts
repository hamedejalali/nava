import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";

/**
 * "لینک ناشناس من": anonymous direct messages.
 *
 * The sender's identity is never shown to the recipient, but the sender id
 * IS stored here so admins can trace abuse if a report ever comes in.
 */
export interface AnonMessageDoc {
  _id: string;
  fromId: number;
  toId: number;
  text: string;
  kind: "message" | "reply";
  replyToId?: string;
  createdAt: Date;
  readAt?: Date;
}

export interface AnonFlowDoc {
  _id: number; // the user who is typing
  stage: "compose" | "reply";
  targetId: number; // who will receive it
  replyToId?: string;
  updatedAt: number;
}

interface PendingDoc {
  _id: number;
  targetId: number;
  createdAt: number;
}

const FLOW_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

async function messages() {
  return (await getDb()).collection<AnonMessageDoc>("anon_messages");
}
async function flows() {
  return (await getDb()).collection<AnonFlowDoc>("anon_msg_flow");
}
async function pendings() {
  return (await getDb()).collection<PendingDoc>("anon_pending_target");
}

export async function createAnonMessage(input: Omit<AnonMessageDoc, "_id" | "createdAt">): Promise<AnonMessageDoc> {
  const doc: AnonMessageDoc = { ...input, _id: randomBytes(9).toString("base64url"), createdAt: new Date() };
  await (await messages()).insertOne(doc);
  return doc;
}
export async function deleteAnonMessage(id: string): Promise<void> {
  await (await messages()).deleteOne({ _id: id });
}
export async function getAnonMessage(id: string): Promise<AnonMessageDoc | null> {
  return (await messages()).findOne({ _id: id });
}
/** Marks a message read exactly once. Returns the doc only the FIRST time. */
export async function markAnonMessageRead(id: string, toId: number): Promise<AnonMessageDoc | null> {
  return (await messages()).findOneAndUpdate(
    { _id: id, toId, readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
    { returnDocument: "after" }
  );
}

export async function setAnonFlow(flow: Omit<AnonFlowDoc, "updatedAt"> | null, userId?: number): Promise<void> {
  const col = await flows();
  if (!flow) {
    if (userId !== undefined) await col.deleteOne({ _id: userId });
    return;
  }
  await col.replaceOne({ _id: flow._id }, { ...flow, updatedAt: Date.now() }, { upsert: true });
}
export async function getAnonFlow(userId: number): Promise<AnonFlowDoc | null> {
  const col = await flows();
  const doc = await col.findOne({ _id: userId });
  if (doc && Date.now() - doc.updatedAt > FLOW_TTL_MS) {
    await col.deleteOne({ _id: userId });
    return null;
  }
  return doc;
}

export async function setPendingTarget(userId: number, targetId: number): Promise<void> {
  await (await pendings()).updateOne({ _id: userId }, { $set: { targetId, createdAt: Date.now() } }, { upsert: true });
}
export async function takePendingTarget(userId: number): Promise<number | null> {
  const col = await pendings();
  const doc = await col.findOneAndDelete({ _id: userId });
  if (!doc || Date.now() - doc.createdAt > PENDING_TTL_MS) return null;
  return doc.targetId;
}
export async function peekPendingTarget(userId: number): Promise<number | null> {
  const doc = await (await pendings()).findOne({ _id: userId });
  if (!doc || Date.now() - doc.createdAt > PENDING_TTL_MS) return null;
  return doc.targetId;
}
