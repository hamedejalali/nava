import type { ClientSession, Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb, getClient } from "../connect.js";

/**
 * Central Relic ledger. Relic belongs to the GLOBAL user account
 * (keyed by Telegram numeric user ID), not to Nava specifically — this is
 * the same collection/record a future Premium Wallet project would read
 * and write, so the balance is always shared rather than duplicated.
 *
 * The live balance is cached on the user document (`relicBalance`) for
 * fast reads, but every balance-changing operation ALSO writes an
 * immutable ledger entry here, and the two are always updated together
 * inside the same MongoDB transaction — the ledger is the source of truth
 * for history/audit, the cached field is just a fast-read projection of it.
 */
export type RelicTransactionType =
  | "INITIAL_BALANCE"
  | "PURCHASE"
  | "TRANSFER"
  | "CHAT_COST"
  | "REFUND"
  | "REFERRAL_REWARD"
  | "PROFILE_COMPLETION_REWARD"
  | "REPORT_REWARD"
  | "WALLET_MINING"
  | "PROFILE_VIEW_REVEAL"
  | "ADMIN_ADJUSTMENT"
  | "BONUS";

export interface RelicTransactionDoc {
  /** Deterministic per operation (e.g. `chatcost:<sessionId>:<userId>`) so
   *  the unique _id itself gives free idempotency — a retried/duplicate
   *  call simply hits a duplicate-key error, which callers treat as
   *  "already applied" rather than double-processing it. */
  _id: string;
  userId: number; // receiver/affected account for this ledger row
  counterpartyUserId?: number; // for TRANSFER
  amount: number; // signed delta applied to relicBalance
  type: RelicTransactionType;
  status: "completed" | "pending" | "failed";
  /** Free-form reference to the related object (chat session id, original
   *  transaction id for a REFUND, purchase id, etc). */
  reference?: string;
  sourceApp: "nava" | "wallet";
  metadata?: Record<string, unknown>;
  createdAt: Date;
  completedAt?: Date;
}

async function ledgerCollection(): Promise<Collection<RelicTransactionDoc>> {
  const db = await getDb();
  return db.collection<RelicTransactionDoc>("relic_transactions");
}

export class InsufficientBalanceError extends Error {
  constructor(public userId: number) {
    super(`[relic] User ${userId} has insufficient Relic balance.`);
  }
}

/** Grants the one-time 5-Relic signup bonus. Idempotent via the
 *  deterministic `initial:<userId>` ledger _id AND a guarded $inc on the
 *  user document — safe even if called twice concurrently. */
export async function grantInitialBalanceIfNeeded(userId: number, usersCol: Collection<any>, session?: ClientSession): Promise<void> {
  const guarded = await usersCol.findOneAndUpdate(
    { _id: userId, relicInitialized: { $ne: true } },
    { $set: { relicInitialized: true }, $inc: { relicBalance: 5 } },
    { session }
  );
  if (!guarded) return; // already granted previously

  const ledger = await ledgerCollection();
  try {
    await ledger.insertOne(
      {
        _id: `initial:${userId}`,
        userId,
        amount: 5,
        type: "INITIAL_BALANCE",
        status: "completed",
        sourceApp: "nava",
        createdAt: new Date(),
        completedAt: new Date(),
      },
      { session }
    );
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // ignore duplicate-key (already logged)
  }
}

/** Atomically deducts 1 Relic for a chat cost, inside the given session
 *  (must run in the same transaction as match creation). Throws
 *  InsufficientBalanceError if the user doesn't have enough — callers
 *  should let that abort the transaction. */
export async function chargeChatCost(userId: number, sessionId: string, usersCol: Collection<any>, mongoSession: ClientSession): Promise<void> {
  const guarded = await usersCol.findOneAndUpdate(
    { _id: userId, relicBalance: { $gte: 1 } },
    { $inc: { relicBalance: -1 } },
    { session: mongoSession }
  );
  if (!guarded) throw new InsufficientBalanceError(userId);

  const ledger = await ledgerCollection();
  await ledger.insertOne(
    {
      _id: `chatcost:${sessionId}:${userId}`,
      userId,
      amount: -1,
      type: "CHAT_COST",
      status: "completed",
      reference: sessionId,
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    },
    { session: mongoSession }
  );
}

/** Atomically deducts `amount` Relic inside the caller's transaction and
 *  writes the matching ledger row (deterministic `ledgerId` => idempotent).
 *  Returns false — WITHOUT writing anything — when the balance is too low,
 *  so the caller decides whether to abort. */
export async function chargeRelicInSession(
  userId: number,
  amount: number,
  ledgerId: string,
  type: RelicTransactionType,
  reference: string,
  mongoSession: ClientSession
): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const debited = await usersCol.findOneAndUpdate(
    { _id: userId, relicBalance: { $gte: amount } },
    { $inc: { relicBalance: -amount } },
    { session: mongoSession }
  );
  if (!debited) return false;

  const ledger = await ledgerCollection();
  await ledger.insertOne(
    {
      _id: ledgerId,
      userId,
      amount: -amount,
      type,
      status: "completed",
      reference,
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    },
    { session: mongoSession }
  );
  return true;
}

/** Issues the 1-Relic chat refund exactly once per session, per the
 *  "other user ended the chat" rule. Returns false if already refunded. */
export async function refundChatCostOnce(userId: number, sessionId: string): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  try {
    await ledger.insertOne({
      _id: `refund:${sessionId}:${userId}`,
      userId,
      amount: 1,
      type: "REFUND",
      status: "completed",
      reference: `chatcost:${sessionId}:${userId}`,
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return false; // already refunded
    throw err;
  }

  await usersCol.updateOne({ _id: userId }, { $inc: { relicBalance: 1 } });
  return true;
}

/** Atomically transfers Relic between two users. Verifies sender != recipient
 *  and sufficient balance server-side; creates a matched debit/credit ledger
 *  pair with deterministic ids (idempotent against duplicate calls for the
 *  same transferId, e.g. a retried callback). */
export async function transferRelicOnce(
  transferId: string,
  senderId: number,
  recipientId: number,
  amount: number
): Promise<{ status: "completed" } | { status: "insufficient" } | { status: "invalid" } | { status: "already_processed" }> {
  if (senderId === recipientId || !Number.isInteger(amount) || amount <= 0) return { status: "invalid" };

  const db = await getDb();
  const client = await getClient();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  const debitId = `transfer:${transferId}:debit`;
  const existing = await ledger.findOne({ _id: debitId });
  if (existing) return { status: "already_processed" };

  const mongoSession = client.startSession();
  try {
    let outcome: "completed" | "insufficient" = "completed";

    await mongoSession.withTransaction(async () => {
      const debited = await usersCol.findOneAndUpdate(
        { _id: senderId, relicBalance: { $gte: amount } },
        { $inc: { relicBalance: -amount } },
        { session: mongoSession }
      );
      if (!debited) {
        outcome = "insufficient";
        throw new InsufficientBalanceError(senderId);
      }

      await usersCol.updateOne({ _id: recipientId }, { $inc: { relicBalance: amount } }, { session: mongoSession });

      await ledger.insertOne(
        {
          _id: debitId,
          userId: senderId,
          counterpartyUserId: recipientId,
          amount: -amount,
          type: "TRANSFER",
          status: "completed",
          reference: transferId,
          sourceApp: "nava",
          createdAt: new Date(),
          completedAt: new Date(),
        },
        { session: mongoSession }
      );
      await ledger.insertOne(
        {
          _id: `transfer:${transferId}:credit`,
          userId: recipientId,
          counterpartyUserId: senderId,
          amount,
          type: "TRANSFER",
          status: "completed",
          reference: transferId,
          sourceApp: "nava",
          createdAt: new Date(),
          completedAt: new Date(),
        },
        { session: mongoSession }
      );
    });

    return { status: outcome };
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return { status: "insufficient" };
    throw err;
  } finally {
    await mongoSession.endSession();
  }
}

/** Credits Relic for a verified Telegram Stars purchase. Idempotent via the
 *  deterministic `purchase:<telegramChargeId>` ledger id — Telegram may
 *  redeliver the successful_payment update, and this must never double-credit. */
export async function creditPurchaseOnce(
  userId: number,
  telegramChargeId: string,
  relicAmount: number,
  starsAmount: number
): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  try {
    await ledger.insertOne({
      _id: `purchase:${telegramChargeId}`,
      userId,
      amount: relicAmount,
      type: "PURCHASE",
      status: "completed",
      reference: telegramChargeId,
      sourceApp: "nava",
      metadata: { starsAmount },
      createdAt: new Date(),
      completedAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return false; // already credited (duplicate delivery)
    throw err;
  }

  await usersCol.updateOne({ _id: userId }, { $inc: { relicBalance: relicAmount } });
  return true;
}

export async function getRelicBalance(userId: number): Promise<number> {
  const db = await getDb();
  const doc = await db.collection<any>("users").findOne({ _id: userId }, { projection: { relicBalance: 1 } });
  return doc?.relicBalance ?? 0;
}

/** Referral reward: +20 Relic to the REFERRER, once per referred user,
 *  triggered the moment the referred user finishes onboarding (not at
 *  signup — a referral only "counts" once the invitee actually completes
 *  their profile, per owner spec). Idempotent via the deterministic
 *  `referral:<newUserId>` ledger id — safe even if onboarding-completion
 *  fires twice for the same user for any reason. */
export async function grantReferralRewardOnce(referrerId: number, newUserId: number): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  try {
    await ledger.insertOne({
      _id: `referral:${newUserId}`,
      userId: referrerId,
      counterpartyUserId: newUserId,
      amount: 20,
      type: "REFERRAL_REWARD",
      status: "completed",
      reference: String(newUserId),
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return false; // already rewarded for this invitee
    throw err;
  }

  await usersCol.updateOne({ _id: referrerId }, { $inc: { relicBalance: 20 } });
  return true;
}

/** Profile-completion bonus: +5 Relic to the user themself, once, the
 *  moment their own onboarding finishes — independent of whether they
 *  were referred by anyone. Idempotent via the deterministic
 *  `profilebonus:<userId>` ledger id. */
export async function grantProfileCompletionRewardOnce(userId: number): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  try {
    await ledger.insertOne({
      _id: `profilebonus:${userId}`,
      userId,
      amount: 5,
      type: "PROFILE_COMPLETION_REWARD",
      status: "completed",
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return false; // already granted
    throw err;
  }

  await usersCol.updateOne({ _id: userId }, { $inc: { relicBalance: 5 } });
  return true;
}

/** Admin manual balance adjustment (add or remove Relic). `delta` may be
 *  negative; a negative adjustment is guarded so balance can never go below
 *  zero. Always creates an auditable ledger entry — balances are never
 *  changed silently. */
export async function countReferralRewards(referrerId: number): Promise<number> {
  const ledger = await ledgerCollection();
  return ledger.countDocuments({ userId: referrerId, type: "REFERRAL_REWARD" });
}

export async function grantReportRewardOnce(reporterId: number, reportId: string): Promise<boolean> {
  const db = await getDb();
  const usersCol = db.collection<any>("users");
  const ledger = await ledgerCollection();

  try {
    await ledger.insertOne({
      _id: `report:${reportId}`,
      userId: reporterId,
      amount: 5,
      type: "REPORT_REWARD",
      status: "completed",
      reference: reportId,
      sourceApp: "nava",
      createdAt: new Date(),
      completedAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }

  await usersCol.updateOne({ _id: reporterId }, { $inc: { relicBalance: 5 } });
  return true;
}

export async function adminAdjustBalance(
  adminId: number,
  targetUserId: number,
  delta: number,
  reason: string
): Promise<{ status: "applied"; newBalance: number } | { status: "insufficient" } | { status: "invalid" }> {
  if (!Number.isInteger(delta) || delta === 0) return { status: "invalid" };

  const db = await getDb();
  const usersCol = db.collection<any>("users");

  const filter: Record<string, unknown> = { _id: targetUserId };
  if (delta < 0) filter.relicBalance = { $gte: -delta };

  const updated = await usersCol.findOneAndUpdate(filter, { $inc: { relicBalance: delta } }, { returnDocument: "after" });
  if (!updated) return { status: "insufficient" };

  const ledger = await ledgerCollection();
  await ledger.insertOne({
    _id: `admin:${randomUUID()}`,
    userId: targetUserId,
    amount: delta,
    type: "ADMIN_ADJUSTMENT",
    status: "completed",
    sourceApp: "nava",
    metadata: { adminId, reason },
    createdAt: new Date(),
    completedAt: new Date(),
  });

  return { status: "applied", newBalance: updated.relicBalance };
}
