import type { ClientSession } from "mongodb";
import { getDb } from "../connect.js";

/**
 * Durable "your search timed out" work item. The queue document can disappear on its own (MongoDB's TTL
 * sweep deletes expired `match_queue` entries within about a minute, long before a daily cron could look at
 * them), so the promise to notify the person lives HERE, in a record that is not subject to that TTL:
 *   armed   -> created when the search starts
 *   void    -> the search ended otherwise (matched / cancelled / replaced by a newer search): nothing to say
 *   sending -> one worker (the countdown, the cron or a webhook pass) owns the delivery (lease)
 *   sent    -> notice delivered, or it can never be delivered (blocked the bot)
 * Every transition is a single atomic MongoDB update, so concurrent workers cannot notify twice, and a
 * newer search by the same person is never touched (ids contain the search's own creation time).
 */
export type NoticeState = "armed" | "sending" | "void" | "sent" | "gave_up";

export interface SearchNoticeDoc {
  _id: string; // `${userId}:${queueCreatedAtMs}`
  userId: number;
  queueCreatedAt: Date;
  dueAt: Date;
  statusMessageId?: number;
  state: NoticeState;
  attempts: number;
  leaseUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_NOTICE_ATTEMPTS = 6;
const LEASE_MS = 90_000;

export const noticeId = (userId: number, queueCreatedAt: Date) => `${userId}:${queueCreatedAt.getTime()}`;

async function col() {
  return (await getDb()).collection<SearchNoticeDoc>("search_notices");
}

export async function ensureSearchNoticeIndexes(): Promise<void> {
  const c = await col();
  await c.createIndexes([
    { key: { state: 1, dueAt: 1 }, name: "state_due" },
    { key: { userId: 1, state: 1 }, name: "user_state" },
    { key: { updatedAt: 1 }, name: "updated_ttl", expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { state: { $in: ["void", "sent", "gave_up"] } } },
  ]);
}

/** Registers the promise "tell this person if their search times out". Any older armed notice of the same
 *  person is voided (a newer search replaces the older one). Idempotent. */
export async function armSearchNotice(userId: number, queueCreatedAt: Date, dueAt: Date, statusMessageId?: number): Promise<void> {
  const c = await col();
  const id = noticeId(userId, queueCreatedAt);
  const now = new Date();
  await c.updateMany({ userId, state: "armed", _id: { $ne: id } }, { $set: { state: "void", updatedAt: now } });
  await c.updateOne(
    { _id: id },
    { $setOnInsert: { _id: id, userId, queueCreatedAt, dueAt, state: "armed", attempts: 0, createdAt: now, updatedAt: now, ...(statusMessageId ? { statusMessageId } : {}) } },
    { upsert: true },
  );
}

export async function setNoticeStatusMessage(userId: number, queueCreatedAt: Date, statusMessageId: number): Promise<void> {
  const c = await col();
  await c.updateOne({ _id: noticeId(userId, queueCreatedAt) }, { $set: { statusMessageId, updatedAt: new Date() } });
}

/** The search ended without timing out (matched, cancelled, replaced): there is nothing to announce.
 *  Only ARMED notices are voided; one already being delivered stays with its owner. */
export async function voidSearchNotices(userIds: number[], session?: ClientSession): Promise<void> {
  const c = await col();
  await c.updateMany({ userId: { $in: userIds }, state: "armed" }, { $set: { state: "void", updatedAt: new Date() } }, { session });
}

export type ClaimResult = { status: "claimed"; notice: SearchNoticeDoc } | { status: "taken" } | { status: "none" };

/** Takes the exclusive right to deliver THIS search's timeout notice. `none` = no record exists (legacy
 *  search / arming failed): the caller may deliver on its own like before. `taken` = already handled/owned. */
export async function claimSearchNotice(userId: number, queueCreatedAt: Date, opts: { requireDue?: boolean } = {}): Promise<ClaimResult> {
  const c = await col();
  const id = noticeId(userId, queueCreatedAt);
  const now = new Date();
  const got = await c.findOneAndUpdate(
    {
      _id: id,
      ...(opts.requireDue ? { dueAt: { $lte: now } } : {}),
      $or: [{ state: "armed" }, { state: "sending", leaseUntil: { $lte: now } }],
    },
    { $set: { state: "sending", leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (got) return { status: "claimed", notice: got };
  return (await c.findOne({ _id: id }, { projection: { _id: 1 } })) ? { status: "taken" } : { status: "none" };
}

export async function finishSearchNotice(id: string, state: "sent" | "void" | "gave_up"): Promise<void> {
  const c = await col();
  await c.updateOne({ _id: id }, { $set: { state, updatedAt: new Date() }, $unset: { leaseUntil: "" } });
}

/** Delivery failed transiently: hand it back for a later retry (bounded). */
export async function releaseSearchNotice(notice: SearchNoticeDoc): Promise<"released" | "gave_up"> {
  if (notice.attempts >= MAX_NOTICE_ATTEMPTS) {
    await finishSearchNotice(notice._id, "gave_up");
    return "gave_up";
  }
  const c = await col();
  await c.updateOne({ _id: notice._id }, { $set: { state: "armed", updatedAt: new Date() }, $unset: { leaseUntil: "" } });
  return "released";
}

export async function findDueSearchNotices(limit = 25): Promise<SearchNoticeDoc[]> {
  const c = await col();
  const now = new Date();
  return c
    .find({ $or: [{ state: "armed", dueAt: { $lte: now } }, { state: "sending", leaseUntil: { $lte: now } }] })
    .sort({ dueAt: 1 })
    .limit(limit)
    .toArray();
}

export async function noticeExistsFor(userId: number, queueCreatedAt: Date): Promise<boolean> {
  const c = await col();
  return !!(await c.findOne({ _id: noticeId(userId, queueCreatedAt) }, { projection: { _id: 1 } }));
}
