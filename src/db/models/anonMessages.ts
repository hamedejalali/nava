import { randomBytes } from "node:crypto";
import type { ClientSession } from "mongodb";
import { getDb } from "../connect.js";
import { runInTransaction, TxAbort } from "../tx.js";

/**
 * "لینک ناشناس من": anonymous direct messages.
 *
 * The sender's identity is never shown to the recipient, but the sender id
 * IS stored here so admins can trace abuse if a report ever comes in.
 */
export interface AnonMessageDoc {
  /** Internal record key (v1.29.3+: `<fromId>:<telegram message id>` — the duplicate-protection key). NEVER put it in anything the
   *  recipient can see (callback data, text): it contains the sender's Telegram id. */
  _id: string;
  /** v1.29.4: opaque random handle used in the inline buttons instead of `_id`. Records written before 1.29.4 do not have one. */
  cbId?: string;
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
  /** v1.29.4 lease: while `claimUntil` is in the future one worker owns this link; `claimToken` proves ownership. */
  claimUntil?: number;
  claimToken?: string;
  /** number of claims since the link was stored / last released on purpose (bounded retries) */
  attempts?: number;
}

const FLOW_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** how long one worker may own a pending link. v1.29.6: 90 s — deliberately LONGER than the 60 s `maxDuration` of api/webhook.ts (see
 *  vercel.json; a regression test keeps the two apart), so a lease can never expire while its own worker is still alive. */
export const PENDING_LEASE_MS = 90 * 1000;
/** a link whose continuation failed this many times is given up (it also expires after PENDING_TTL_MS) */
export const PENDING_MAX_ATTEMPTS = 3;

let anonIndexesEnsured = false;
/** One non-unique sparse index for the button lookups. Idempotent; failures only mean slower lookups until the next try. */
function ensureAnonIndexesOnce(): void {
  if (anonIndexesEnsured) return;
  anonIndexesEnsured = true;
  void messages()
    .then((c) => c.createIndex({ cbId: 1 }, { name: "cbId_1", sparse: true }))
    .catch(() => {
      anonIndexesEnsured = false;
    });
}

async function messages() {
  return (await getDb()).collection<AnonMessageDoc>("anon_messages");
}
async function flows() {
  return (await getDb()).collection<AnonFlowDoc>("anon_msg_flow");
}
async function pendings() {
  return (await getDb()).collection<PendingDoc>("anon_pending_target");
}

export async function createAnonMessage(
  input: Omit<AnonMessageDoc, "_id" | "createdAt">,
  opts?: { session?: ClientSession; id?: string }
): Promise<AnonMessageDoc> {
  ensureAnonIndexesOnce();
  const doc: AnonMessageDoc = { ...input, _id: opts?.id ?? randomBytes(9).toString("base64url"), cbId: randomBytes(12).toString("base64url"), createdAt: new Date() };
  await (await messages()).insertOne(doc, opts?.session ? { session: opts.session } : undefined);
  return doc;
}
export async function deleteAnonMessage(id: string): Promise<void> {
  await (await messages()).deleteOne({ _id: id });
}
export async function getAnonMessage(id: string): Promise<AnonMessageDoc | null> {
  return (await messages()).findOne({ _id: id });
}
/**
 * Resolves the id carried by an inline button («پاسخ دادن» / «خوندم»). Records written since v1.29.4 are found ONLY through their opaque
 * `cbId`; records without one (older messages, whose button carries the record `_id`) are still found through `_id`, so buttons that
 * already sit in chats keep working. A new record is deliberately NOT reachable through its `_id`: otherwise a recipient could probe
 * `<senderId>:<n>` guesses and use the answer to confirm who wrote to them. The caller must still check `doc.toId` (ownership).
 */
export async function getAnonMessageByButtonId(id: string): Promise<AnonMessageDoc | null> {
  if (!/^[A-Za-z0-9_:-]{1,40}$/.test(id)) return null;
  const col = await messages();
  return (await col.findOne({ cbId: id })) ?? (await col.findOne({ _id: id, cbId: { $exists: false } }));
}
/**
 * v1.29.6 (F-22 compatibility) — records written by v1.29.3 have an `_id` of the form `<senderTelegramId>:<telegramMessageId>` and no `cbId`,
 * so the buttons already sitting in recipients' chats carry the sender's Telegram id. (Records from before v1.29.3 have a random id and
 * are not affected.) Nothing can rewrite those messages in bulk (the Telegram message id of the notification was never stored), so they are
 * upgraded lazily: the first time the recipient presses such a button the keyboard of THAT message is replaced by one with an opaque handle.
 */
export function isLegacyExposedId(doc: Pick<AnonMessageDoc, "_id" | "cbId">): boolean {
  return !doc.cbId && /^-?\d+:/.test(doc._id);
}
/** Gives a legacy record an opaque handle (only if it has none yet) and returns the handle that is stored. */
export async function assignButtonId(id: string): Promise<string | null> {
  ensureAnonIndexesOnce();
  const col = await messages();
  const cbId = randomBytes(12).toString("base64url");
  const doc = await col.findOneAndUpdate({ _id: id, cbId: { $exists: false } }, { $set: { cbId } }, { returnDocument: "after" });
  if (doc) return doc.cbId ?? null;
  return (await col.findOne({ _id: id }))?.cbId ?? null; // somebody else upgraded it first: use theirs
}
/** Takes a freshly assigned handle back (the keyboard could not be replaced, so the old button must keep working). */
export async function revokeButtonId(id: string, cbId: string): Promise<void> {
  await (await messages()).updateOne({ _id: id, cbId }, { $unset: { cbId: "" } });
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
  // a (re)opened link always starts fresh: new timestamp, no lease, no failed attempts
  await (await pendings()).updateOne(
    { _id: userId },
    { $set: { targetId, createdAt: Date.now(), attempts: 0 }, $unset: { claimUntil: "", claimToken: "" } },
    { upsert: true }
  );
}

/**
 * v1.29.4 — lease instead of destructive consumption. Exactly one caller gets the link while no unexpired lease exists; the record
 * stays in the database until `completePending` (continuation reached its intended state) or it expires / runs out of attempts. A worker that
 * crashes simply lets its lease run out and a later caller can claim the link again.
 */
export async function claimPendingTarget(userId: number, now = Date.now()): Promise<{ targetId: number; token: string } | null> {
  const col = await pendings();
  const token = randomBytes(9).toString("base64url");
  const doc = await col.findOneAndUpdate(
    {
      _id: userId,
      createdAt: { $gt: now - PENDING_TTL_MS },
      $and: [
        { $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: now } }] },
        { $or: [{ attempts: { $exists: false } }, { attempts: { $lt: PENDING_MAX_ATTEMPTS } }] },
      ],
    },
    { $set: { claimUntil: now + PENDING_LEASE_MS, claimToken: token }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  if (!doc) {
    await col.deleteOne({ _id: userId, createdAt: { $lte: now - PENDING_TTL_MS } }); // housekeeping: an expired link is gone for good
    return null;
  }
  return { targetId: doc.targetId, token };
}
/** The continuation reached its intended state (or the link was refused for good): remove it. Only the current lease holder may. */
export async function completePending(userId: number, token: string): Promise<boolean> {
  return ((await (await pendings()).deleteOne({ _id: userId, claimToken: token })).deletedCount ?? 0) > 0;
}
/**
 * v1.29.6 — the LAST step of a leased continuation, atomically: only the CURRENT lease holder (token still matches) both removes the pending
 * link and creates the compose flow, in one transaction. A worker whose lease ran out meanwhile (somebody else claimed the link, or the user
 * opened a different link) changes nothing and gets `false`: it must not write a stale flow or send a second prompt.
 */
export async function completePendingWithFlow(userId: number, token: string, flow: Omit<AnonFlowDoc, "updatedAt">): Promise<boolean> {
  try {
    await runInTransaction(async (session) => {
      const removed = await (await pendings()).deleteOne({ _id: userId, claimToken: token }, { session });
      if ((removed.deletedCount ?? 0) < 1) throw new TxAbort("lease_lost");
      await (await flows()).replaceOne({ _id: flow._id }, { ...flow, updatedAt: Date.now() }, { upsert: true, session });
    });
    return true;
  } catch (err) {
    if (err instanceof TxAbort) return false;
    throw err;
  }
}
/** Gives the link back on purpose (e.g. the force-join screen was shown and the user will continue later): not a failure, attempts reset. */
export async function releasePending(userId: number, token: string): Promise<void> {
  await (await pendings()).updateOne({ _id: userId, claimToken: token }, { $unset: { claimUntil: "", claimToken: "" }, $set: { attempts: 0 } });
}
/** Unconditional removal (the direct «open the link» path, which never leases). */
export async function clearPending(userId: number): Promise<void> {
  await (await pendings()).deleteOne({ _id: userId });
}
/** Pre-1.29.4 destructive read; no longer used by the feature (kept so nothing importing it breaks). */
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
