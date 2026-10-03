import type { Collection } from "mongodb";
import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";

/**
 * A "request to chat" sent from the Nava Mini App (public/miniapp).
 *
 * Lifecycle: pending -> accepted | declined | expired | failed.
 * MongoDB is the only source of truth: the pending state, its expiry and
 * its one-time-accept guard all live here, so everything survives Vercel
 * cold starts and duplicate Telegram deliveries.
 */
export type ChatRequestStatus = "pending" | "accepted" | "declined" | "expired" | "failed";

export interface ChatRequestDoc {
  /** Opaque random token (also used in the accept/decline button data). */
  _id: string;
  fromId: number;
  toId: number;
  status: ChatRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  respondedAt?: Date;
  sessionId?: string;
}

export const CHAT_REQUEST_TTL_MS = 10 * 60 * 1000;
export const CHAT_REQUEST_HOURLY_LIMIT = 10;

export async function chatRequestCollection(): Promise<Collection<ChatRequestDoc>> {
  const db = await getDb();
  return db.collection<ChatRequestDoc>("chat_requests");
}

export async function ensureChatRequestIndexes(): Promise<void> {
  const col = await chatRequestCollection();
  await col.createIndexes([
    // at most ONE pending request per (from -> to) pair, enforced by Mongo
    { key: { fromId: 1, toId: 1 }, name: "pending_pair_unique", unique: true, partialFilterExpression: { status: "pending" } },
    { key: { fromId: 1, createdAt: -1 }, name: "from_createdAt" },
    // request history is not needed long-term
    { key: { createdAt: 1 }, name: "createdAt_ttl", expireAfterSeconds: 7 * 24 * 3600 },
  ]);
}

export type CreateChatRequestResult =
  | { status: "created"; request: ChatRequestDoc }
  | { status: "already_pending" }
  | { status: "rate_limited" };

export async function createChatRequest(fromId: number, toId: number, now = new Date()): Promise<CreateChatRequestResult> {
  const col = await chatRequestCollection();

  // An old pending request that already ran out is closed first so the
  // unique "one pending per pair" index doesn't block a fresh one.
  await col.updateMany({ fromId, toId, status: "pending", expiresAt: { $lte: now } }, { $set: { status: "expired", respondedAt: now } });

  const recent = await col.countDocuments({ fromId, createdAt: { $gt: new Date(now.getTime() - 3600_000) } });
  if (recent >= CHAT_REQUEST_HOURLY_LIMIT) return { status: "rate_limited" };

  const request: ChatRequestDoc = {
    _id: randomBytes(9).toString("base64url"),
    fromId,
    toId,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHAT_REQUEST_TTL_MS),
  };
  try {
    await col.insertOne(request);
  } catch (err: any) {
    if (err?.code === 11000) return { status: "already_pending" };
    throw err;
  }
  return { status: "created", request };
}

/** Atomically moves a pending request to `declined`. Only the addressee can
 *  do it, and only once. Returns the request, or null if it was not pending. */
export async function declineChatRequestOnce(token: string, toId: number, now = new Date()): Promise<ChatRequestDoc | null> {
  const col = await chatRequestCollection();
  return col.findOneAndUpdate(
    { _id: token, toId, status: "pending" },
    { $set: { status: "declined", respondedAt: now } },
    { returnDocument: "after" }
  );
}
