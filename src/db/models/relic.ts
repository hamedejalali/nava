import type { ClientSession, Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb, getClient } from "../connect.js";
import { tryIssueFromSupply } from "./walletCore.js";

/**
 * Central Relic ledger. Relic belongs to the GLOBAL user account
 * (keyed by Telegram numeric user ID), not to Nava specifically — this is
 * the same collection/record the Premium Wallet project reads and writes,
 * so the balance is always shared rather than duplicated.
 *
 * The live balance is cached on the user document (`relicBalance`) for
 * fast reads, but every balance-changing operation ALSO writes an
 * immutable ledger entry here. `relic_transactions` is the source of
 * truth for history/audit; `relicBalance` is a fast-read projection of it
 * that must never be allowed to diverge from it.
 *
 * FIXED (see CHANGELOG v1.4.0): every function in this file that grants or
 * refunds Relic used to write the ledger row and the `relicBalance` $inc as
 * TWO SEPARATE, unrelated writes (ledger first, dedup on its unique _id;
 * balance second, plain updateOne). If the process crashed, timed out, or
 * MongoDB rejected the second write for any reason after the first
 * succeeded, the ledger and the balance would permanently disagree — e.g.
 * a "profilebonus:<id>" row could exist forever while relicBalance never
 * actually received the +5. All of them now go through `creditLedgerOnce`,
 * which puts the ledger insert and the balance $inc in ONE MongoDB
 * transaction: either both happen or neither does, and a duplicate/retried
 * call is detected via the ledger row's deterministic _id and safely
 * turned into a no-op (returns false) without ever touching the balance
 * twice. Every caller's function name, signature and return type is
 * unchanged.
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
  | "RECOVERY_OUT"
  | "RECOVERY_IN"
  | "WALLET_TRANSFER_IN"
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

/** AUDITED (v1.5.0): this ledger had no index beyond the default one on
 *  `_id` — fine for every lookup/insert here (all keyed by a deterministic
 *  `_id`), except `countReferralRewards`, which filters by `userId` +
 *  `type` on a collection that only ever grows (never TTL-cleaned, unlike
 *  most other collections in this project). One compound index matches
 *  that exact query. */
export async function ensureRelicLedgerIndexes(): Promise<void> {
  const col = await ledgerCollection();
  await col.createIndexes([{ key: { userId: 1, type: 1 }, name: "userId_type" }]);
}

export class InsufficientBalanceError extends Error {
  constructor(public userId: number) {
    super(`[relic] User ${userId} has insufficient Relic balance.`);
  }
}

/** Internal marker used to abort a transaction cleanly when the ledger's
 *  deterministic _id already exists (this exact operation was already
 *  applied before) — caught outside the transaction and turned into a
 *  plain `false` / no-op return, never a real error to the caller. */
class AlreadyProcessedError extends Error {}
/** Thrown inside a reward transaction when the owner's finite Relic supply cannot cover it: nothing is granted. */
class SupplyShortError extends Error {}

/** Rewards that NEW Relic is created for. They are drawn from the wallet's finite total supply
 *  (the owner-set cap); once it is exhausted these rewards are simply not granted. Paid purchases,
 *  refunds of a previous charge, transfers and admin adjustments are NOT drawn from it. */
const SUPPLY_BACKED_TYPES = new Set<RelicTransactionType>(["REFERRAL_REWARD", "PROFILE_COMPLETION_REWARD", "REPORT_REWARD", "BONUS"]);

/**
 * Shared building block for every "credit or refund N Relic to this user,
 * exactly once, identified by a deterministic ledger id" operation. Runs
 * the ledger insert and the balance update in ONE transaction: if the
 * ledger insert fails because `ledgerId` already exists (a genuine retry
 * or duplicate delivery), the transaction is aborted before the balance is
 * touched and this returns `false`. Otherwise both writes commit together
 * and this returns `true`. `amount` may be negative (used internally by
 * `chargeRelicInSession`-style callers that want the same atomic
 * guarantee together with a balance floor — see that function instead for
 * charges that must never go negative).
 */
async function creditLedgerOnce(
  ledgerId: string,
  userId: number,
  amount: number,
  type: RelicTransactionType,
  extra: { reference?: string; counterpartyUserId?: number; metadata?: Record<string, unknown> } = {}
): Promise<boolean> {
  const client = await getClient();
  const usersCol = (await getDb()).collection<any>("users");
  const ledger = await ledgerCollection();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      try {
        await ledger.insertOne(
          {
            _id: ledgerId,
            userId,
            amount,
            type,
            status: "completed",
            sourceApp: "nava",
            createdAt: new Date(),
            completedAt: new Date(),
            ...extra,
          },
          { session }
        );
      } catch (err: any) {
        if (err?.code === 11000) throw new AlreadyProcessedError();
        throw err;
      }
      if (SUPPLY_BACKED_TYPES.has(type) && amount > 0 && !(await tryIssueFromSupply(amount, session))) throw new SupplyShortError();
      await usersCol.updateOne({ _id: userId }, { $inc: { relicBalance: amount } }, { session });
    });
    return true;
  } catch (err) {
    if (err instanceof AlreadyProcessedError || err instanceof SupplyShortError) return false;
    throw err;
  } finally {
    await session.endSession();
  }
}

/** Grants the one-time 5-Relic signup bonus. Idempotent via the guarded
 *  `relicInitialized` flip AND the deterministic `initial:<userId>` ledger
 *  id; both the flag flip and the ledger row now commit in the SAME
 *  transaction (see the class doc comment above for why this matters), so
 *  a user can never end up with the balance credited but no ledger row, or
 *  vice versa. If the caller already owns an open transaction (`session`
 *  is passed in), this participates in that transaction instead of
 *  starting a new one — MongoDB does not support nested transactions on
 *  one client. */
export async function grantInitialBalanceIfNeeded(userId: number, usersCol: Collection<any>, session?: ClientSession): Promise<void> {
  const ledger = await ledgerCollection();

  const run = async (s: ClientSession | undefined): Promise<void> => {
    // The 5-Relic signup gift is also drawn from the finite supply; if it is exhausted nothing is granted
    // (and the flag stays unset so it can still be granted once the owner adds supply).
    const guarded = await usersCol.findOneAndUpdate(
      { _id: userId, relicInitialized: { $ne: true } },
      { $set: { relicInitialized: true }, $inc: { relicBalance: 5 } },
      { session: s }
    );
    if (!guarded) return; // already granted previously

    // Drawn from the finite supply only once we know this is the first grant. If the supply cannot cover it,
    // undo the flag/balance bump inside the same session (never throw: that would abort the caller's onboarding).
    if (s && !(await tryIssueFromSupply(5, s))) {
      await usersCol.updateOne({ _id: userId }, { $set: { relicInitialized: false }, $inc: { relicBalance: -5 } }, { session: s });
      return;
    }

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
        { session: s }
      );
    } catch (err: any) {
      // Should be unreachable now that the flag-flip and the ledger write
      // are atomic together — kept as a hard safety net: if it ever does
      // happen, abort rather than commit a balance bump with no ledger row.
      if (err?.code === 11000) throw new AlreadyProcessedError();
      throw err;
    }
  };

  if (session) {
    await run(session);
    return;
  }

  const client = await getClient();
  const localSession = client.startSession();
  try {
    await localSession.withTransaction(() => run(localSession));
  } catch (err) {
    if (!(err instanceof AlreadyProcessedError)) throw err;
  } finally {
    await localSession.endSession();
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
  return creditLedgerOnce(`refund:${sessionId}:${userId}`, userId, 1, "REFUND", { reference: `chatcost:${sessionId}:${userId}` });
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

      try {
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
      } catch (err: any) {
        // A genuinely concurrent second call with the SAME transferId can
        // race past the pre-check above and reach here at the same time —
        // MongoDB's unique index on `_id` is the real, final guard. Treat
        // it exactly like the pre-check: no error, just "already done".
        if (err?.code === 11000) throw new AlreadyProcessedError();
        throw err;
      }
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
    if (err instanceof AlreadyProcessedError) return { status: "already_processed" };
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
  return creditLedgerOnce(`purchase:${telegramChargeId}`, userId, relicAmount, "PURCHASE", {
    reference: telegramChargeId,
    metadata: { starsAmount },
  });
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
  return creditLedgerOnce(`referral:${newUserId}`, referrerId, 20, "REFERRAL_REWARD", {
    counterpartyUserId: newUserId,
    reference: String(newUserId),
  });
}

/** Profile-completion bonus: +5 Relic to the user themself, once, the
 *  moment their own onboarding finishes — independent of whether they
 *  were referred by anyone. Idempotent via the deterministic
 *  `profilebonus:<userId>` ledger id. */
export async function grantProfileCompletionRewardOnce(userId: number): Promise<boolean> {
  return creditLedgerOnce(`profilebonus:${userId}`, userId, 5, "PROFILE_COMPLETION_REWARD");
}

export async function countReferralRewards(referrerId: number): Promise<number> {
  const ledger = await ledgerCollection();
  return ledger.countDocuments({ userId: referrerId, type: "REFERRAL_REWARD" });
}

export async function grantReportRewardOnce(reporterId: number, reportId: string): Promise<boolean> {
  return creditLedgerOnce(`report:${reportId}`, reporterId, 5, "REPORT_REWARD", { reference: reportId });
}

/** Admin manual balance adjustment (add or remove Relic). `delta` may be
 *  negative; a negative adjustment is guarded so balance can never go below
 *  zero. Always creates an auditable ledger entry, in the SAME transaction
 *  as the balance change — an admin adjustment can never end up applied to
 *  one but not the other. */
export async function adminAdjustBalance(
  adminId: number,
  targetUserId: number,
  delta: number,
  reason: string
): Promise<{ status: "applied"; newBalance: number } | { status: "insufficient" } | { status: "invalid" }> {
  if (!Number.isInteger(delta) || delta === 0) return { status: "invalid" };

  const client = await getClient();
  const usersCol = (await getDb()).collection<any>("users");
  const ledger = await ledgerCollection();
  const ledgerId = `admin:${randomUUID()}`;

  const filter: Record<string, unknown> = { _id: targetUserId };
  if (delta < 0) filter.relicBalance = { $gte: -delta };

  const session = client.startSession();
  try {
    let result: { status: "applied"; newBalance: number } | { status: "insufficient" } = { status: "insufficient" };

    await session.withTransaction(async () => {
      const updated = await usersCol.findOneAndUpdate(filter, { $inc: { relicBalance: delta } }, { session, returnDocument: "after" });
      if (!updated) {
        result = { status: "insufficient" };
        throw new InsufficientBalanceError(targetUserId);
      }

      await ledger.insertOne(
        {
          _id: ledgerId,
          userId: targetUserId,
          amount: delta,
          type: "ADMIN_ADJUSTMENT",
          status: "completed",
          sourceApp: "nava",
          metadata: { adminId, reason },
          createdAt: new Date(),
          completedAt: new Date(),
        },
        { session }
      );
      result = { status: "applied", newBalance: updated.relicBalance };
    });

    return result;
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return { status: "insufficient" };
    throw err;
  } finally {
    await session.endSession();
  }
}
