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
  /** where the conversation will happen: "miniapp" = inside Navagram (direct messages), absent/"bot" = the bot chat */
  origin?: "bot" | "miniapp";
}

/** v1.23: a request never runs out by itself (XP is only checked and charged when the other person accepts). */
export const CHAT_REQUEST_TTL_MS = 20 * 365 * 24 * 3600 * 1000;
export const CHAT_REQUEST_HOURLY_LIMIT = 10;

export async function chatRequestCollection(): Promise<Collection<ChatRequestDoc>> {
  const db = await getDb();
  return db.collection<ChatRequestDoc>("chat_requests");
}

export async function ensureChatRequestIndexes(): Promise<void> {
  const col = await chatRequestCollection();
  // the old index deleted every request after 7 days, pending ones included: drop it (ignore "not found")
  try {
    await (col as any).dropIndex("createdAt_ttl");
  } catch {
    /* not there (or a driver without dropIndex): fine */
  }
  await col.createIndexes([
    // at most ONE pending request per (from -> to) pair, enforced by Mongo
    { key: { fromId: 1, toId: 1 }, name: "pending_pair_unique", unique: true, partialFilterExpression: { status: "pending" } },
    { key: { fromId: 1, createdAt: -1 }, name: "from_createdAt" },
    // answered / cancelled requests are not needed long-term; a PENDING one has no respondedAt and is never deleted
    { key: { respondedAt: 1 }, name: "respondedAt_ttl", expireAfterSeconds: 14 * 24 * 3600 },
  ]);
}

export type CreateChatRequestResult =
  | { status: "created"; request: ChatRequestDoc }
  | { status: "already_pending" }
  | { status: "rate_limited" };

export async function createChatRequest(fromId: number, toId: number, now = new Date(), origin: "bot" | "miniapp" = "bot"): Promise<CreateChatRequestResult> {
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
    origin,
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
