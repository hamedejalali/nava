import type { ClientSession } from "mongodb";
import { getDb } from "../connect.js";

/**
 * Durable "tell this person they are connected" work item (an outbox record). It is written in the SAME
 * transaction that creates the chat session, so a match can never exist without its delivery work, and the
 * work survives the serverless invocation that created it: anyone (the inline attempt, the next webhook
 * request, the cron) can resume it. Money is never touched by a delivery retry — charging happened once, in
 * the match transaction.
 */
export type DeliveryState =
  | "pending" //     not delivered yet (will be retried until MAX_DELIVERY_ATTEMPTS)
  | "delivered" //   full message + chat-control keyboard delivered
  | "degraded" //    delivered, but with a simpler keyboard / plain text because Telegram rejected the rich one
  | "unreachable" // person can never receive messages (blocked the bot) -> match is undone
  | "gave_up" //     transient failures kept happening; chat stays open, needs a human look
  | "void"; //       session ended before delivery, nothing to deliver

export interface MatchDeliveryDoc {
  _id: string; // `${sessionId}:${userId}`
  sessionId: string;
  userId: number;
  kind: "match" | "request";
  state: DeliveryState;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil?: Date;
  /** the "found a partner" line was already sent: a retry sends only what is still missing */
  foundSent?: boolean;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_DELIVERY_ATTEMPTS = 8;
const LEASE_MS = 60_000;

/** 30 s, 60 s, 2 min … capped at 15 min. */
export function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

async function col() {
  return (await getDb()).collection<MatchDeliveryDoc>("match_deliveries");
}

export async function ensureMatchDeliveryIndexes(): Promise<void> {
  const c = await col();
  await c.createIndexes([
    { key: { state: 1, nextAttemptAt: 1 }, name: "state_next" },
    // finished records are kept 7 days for diagnostics, then removed
    { key: { updatedAt: 1 }, name: "updated_ttl", expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { state: { $in: ["delivered", "degraded", "void", "unreachable"] } } },
  ]);
}

export function newDeliveryDocs(sessionId: string, userIds: number[], kind: "match" | "request", now = new Date()): MatchDeliveryDoc[] {
  return userIds.map((userId) => ({ _id: `${sessionId}:${userId}`, sessionId, userId, kind, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }));
}

/** Idempotent (deterministic ids); pass the transaction session to commit together with the match. */
export async function insertDeliveries(docs: MatchDeliveryDoc[], session?: ClientSession): Promise<void> {
  const c = await col();
  for (const d of docs) {
    await c.updateOne({ _id: d._id }, { $setOnInsert: d }, { upsert: true, session });
  }
}

/** Takes the exclusive right to work on one delivery. `force` ignores the backoff time (inline first attempt). */
export async function leaseDelivery(id: string, opts: { force?: boolean } = {}): Promise<MatchDeliveryDoc | null> {
  const c = await col();
  const now = new Date();
  return c.findOneAndUpdate(
    {
      _id: id,
      state: "pending",
      ...(opts.force ? {} : { nextAttemptAt: { $lte: now } }),
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
}

export async function updateDelivery(id: string, patch: Partial<MatchDeliveryDoc>, unsetLease = true): Promise<void> {
  const c = await col();
  await c.updateOne({ _id: id }, { $set: { ...patch, updatedAt: new Date() }, ...(unsetLease ? { $unset: { leaseUntil: "" } } : {}) } as any);
}

export async function findDueDeliveries(limit = 5): Promise<MatchDeliveryDoc[]> {
  const c = await col();
  const now = new Date();
  return c
    .find({ state: "pending", nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .toArray();
}

export async function getDelivery(id: string): Promise<MatchDeliveryDoc | null> {
  return (await col()).findOne({ _id: id });
}
