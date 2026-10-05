import type { Collection } from "mongodb";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { getClient, getDb } from "../connect.js";
import type { UserDoc } from "./user.js";
import { accounts, getOrCreateAccount, insertLedger, displayNameOf } from "./walletCore.js";

/**
 * 12-word wallet recovery phrase (BIP39, 128-bit entropy + 4-bit checksum).
 *
 * DESIGN
 *  - The phrase is generated ONCE per wallet from a CSPRNG (@scure/bip39 ->
 *    crypto.getRandomValues) and returned to the user exactly once, in the
 *    HTTP response of `generate`. It is never stored, never logged and no
 *    admin screen or export can show it.
 *  - We store only `phraseHash` = scrypt(normalized phrase, fixed domain salt).
 *    The phrase has 128 bits of entropy and is machine-generated (a user can
 *    never choose a weak one), so a leaked hash cannot be brute-forced; a
 *    slow KDF is still used as defence in depth. No server secret is involved
 *    on purpose: there is nothing to lose/rotate that would silently make
 *    every stored phrase unusable.
 *  - Documents are keyed by `phraseHash` (`_id`). Uniqueness is therefore
 *    enforced by MongoDB itself: one phrase can only ever belong to one
 *    wallet, and a claim can only ever succeed once.
 *  - Life cycle:  pending_backup --confirm--> active --claim--> claimed
 *      pending_backup : shown to the user, NOT yet secured; cannot be used to
 *                       recover anything. A new `generate` replaces it.
 *      active         : the user proved (by typing it back) that they saved it.
 *      claimed        : burned. The balance moved to another Telegram account.
 *    `live: true` exists only while status is pending_backup/active and a
 *    partial UNIQUE index on ownerId makes "at most one live phrase per
 *    wallet" a database guarantee.
 */
export type RecoveryStatus = "pending_backup" | "active" | "claimed";

export interface WalletRecoveryDoc {
  /** scrypt hash of the normalized phrase (hex). */
  _id: string;
  /** Telegram id of the wallet that owns this phrase. */
  ownerId: number;
  status: RecoveryStatus;
  live?: true;
  /** Random id used in ledger rows (so ledger rows never contain the hash). */
  recoveryId: string;
  createdAt: Date;
  confirmedAt?: Date;
  claimedBy?: number;
  claimedAt?: Date;
  /** What moved on claim (audit only). */
  movedAmount?: number;
}

export const RECOVERY_WORDS = 12;
/** Confirm/claim attempts allowed per user per hour (a success gives its attempt back). */
export const MAX_ATTEMPTS_PER_HOUR = 10;

const KDF_SALT = "nava-wallet-recovery:v1";

export async function recoveryCollection(): Promise<Collection<WalletRecoveryDoc>> {
  const db = await getDb();
  return db.collection<WalletRecoveryDoc>("wallet_recovery");
}

export async function ensureWalletRecoveryIndexes(): Promise<void> {
  const col = await recoveryCollection();
  await col.createIndexes([
    { key: { ownerId: 1 }, name: "one_live_phrase_per_wallet", unique: true, partialFilterExpression: { live: true } },
    { key: { ownerId: 1, status: 1 }, name: "owner_status" },
  ]);
  const db = await getDb();
  await db.collection("wallet_recovery_attempts").createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]);
}

/** lower-case words separated by single spaces; anything that is not a
 *  letter is treated as a separator (newlines, commas, numbering dots...). */
export function normalizePhrase(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 400) return null;
  const words = input
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (words.length !== RECOVERY_WORDS) return null;
  const phrase = words.join(" ");
  return validateMnemonic(phrase, wordlist) ? phrase : null; // checks the wordlist AND the BIP39 checksum
}

export function hashPhrase(normalized: string): string {
  return scryptSync(normalized, KDF_SALT, 32, { N: 2 ** 14, r: 8, p: 1 }).toString("hex");
}

export function generatePhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export type RecoveryState = "none" | "pending_backup" | "active";

export async function getRecoveryState(ownerId: number): Promise<RecoveryState> {
  const col = await recoveryCollection();
  const doc = await col.findOne({ ownerId, live: true });
  return doc ? (doc.status as RecoveryState) : "none";
}

export type GenerateResult = { status: "created"; words: string[] } | { status: "already_active" };

/** Creates (or, while still unconfirmed, replaces) the wallet's phrase. The
 *  words are returned here and nowhere else. */
export async function generateRecoveryPhrase(ownerId: number): Promise<GenerateResult> {
  const col = await recoveryCollection();
  const client = await getClient();
  // A concurrent second `generate` for the same wallet can hit the unique
  // "one live phrase per wallet" index; retrying lets it simply replace the
  // other pending phrase (the one the user actually confirms is the one that
  // was typed back, so a stale phrase can never be confirmed by accident).
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = client.startSession();
    try {
      let result: GenerateResult = { status: "already_active" };
      await session.withTransaction(async () => {
        const live = await col.findOne({ ownerId, live: true }, { session });
        if (live?.status === "active") {
          result = { status: "already_active" };
          return;
        }
        if (live) await col.deleteOne({ _id: live._id, status: "pending_backup" }, { session });

        const phrase = generatePhrase();
        await col.insertOne(
          {
            _id: hashPhrase(phrase),
            ownerId,
            status: "pending_backup",
            live: true,
            recoveryId: randomUUID(),
            createdAt: new Date(),
          },
          { session }
        );
        result = { status: "created", words: phrase.split(" ") };
      });
      return result;
    } catch (err: any) {
      if (err?.code === 11000 && attempt < 2) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("generateRecoveryPhrase: unreachable");
}

export type ConfirmResult = { status: "confirmed" } | { status: "already_active" } | { status: "mismatch" };

/** The user types the phrase back; only then is the wallet "secured". */
export async function confirmRecoveryPhrase(ownerId: number, normalized: string): Promise<ConfirmResult> {
  const col = await recoveryCollection();
  const hash = hashPhrase(normalized);
  const updated = await col.findOneAndUpdate(
    { _id: hash, ownerId, status: "pending_backup", live: true },
    { $set: { status: "active", confirmedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (updated) return { status: "confirmed" };
  const existing = await col.findOne({ _id: hash, ownerId, status: "active", live: true });
  return existing ? { status: "already_active" } : { status: "mismatch" };
}

/** Wrong-guess limiter, stored in MongoDB (shared by every serverless
 *  instance). Counts attempts per user per hour BEFORE doing the work. */
export async function takeAttempt(userId: number, now = new Date()): Promise<{ allowed: boolean }> {
  const db = await getDb();
  const col = db.collection<{ _id: string; count: number; expiresAt: Date }>("wallet_recovery_attempts");
  const window = Math.floor(now.getTime() / 3600_000);
  const doc = await col.findOneAndUpdate(
    { _id: `${userId}:${window}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * 3600_000) } },
    { upsert: true, returnDocument: "after" }
  );
  return { allowed: (doc?.count ?? 1) <= MAX_ATTEMPTS_PER_HOUR };
}

/** Refund a counted attempt after a SUCCESS so only failures consume the budget. */
export async function refundAttempt(userId: number, now = new Date()): Promise<void> {
  const db = await getDb();
  const window = Math.floor(now.getTime() / 3600_000);
  await db.collection<{ _id: string; count: number }>("wallet_recovery_attempts").updateOne({ _id: `${userId}:${window}` }, { $inc: { count: -1 } });
}

export type ClaimResult =
  | { status: "claimed"; movedAmount: number; newBalance: number }
  | { status: "already_claimed_by_you"; newBalance: number }
  | { status: "invalid" } // wrong / unknown / burned / unconfirmed phrase (deliberately indistinguishable)
  | { status: "same_account" }
  | { status: "blocked" } // the claimer or the old wallet is banned
  | { status: "rate_limited" };

class Abort extends Error {
  constructor(public result: ClaimResult) {
    super("abort");
  }
}

/**
 * Re-binds the original wallet's Relic to `claimerId` (a different Telegram
 * account). ONE transaction:
 *   1. burn the phrase (active -> claimed) — only one concurrent claim can
 *      win this step, everyone else sees it already burned;
 *   2. zero the old wallet and read what it held, in the same atomic update;
 *   3. credit exactly that amount to the claimer;
 *   4. write both ledger rows (deterministic ids).
 * Any failure rolls all four back. Replays by the same claimer are answered
 * with `already_claimed_by_you` and move nothing.
 */
export async function claimRecoveryPhrase(claimerId: number, normalized: string, now = new Date()): Promise<ClaimResult> {
  const hash = hashPhrase(normalized);
  const col = await recoveryCollection();
  const db = await getDb();
  const users = db.collection<UserDoc>("users");
  const ledger = db.collection<any>("relic_transactions");
  const client = await getClient();

  const existing = await col.findOne({ _id: hash });
  if (existing?.status === "claimed") {
    if (existing.claimedBy === claimerId) {
      const me = await getOrCreateAccount(claimerId);
      return { status: "already_claimed_by_you", newBalance: me.balance };
    }
    return { status: "invalid" };
  }
  if (!existing || existing.status !== "active") return { status: "invalid" };
  if (existing.ownerId === claimerId) return { status: "same_account" };
  await getOrCreateAccount(claimerId); // make sure the receiving wallet account exists before the transaction

  const session = client.startSession();
  try {
    let result: ClaimResult = { status: "invalid" };
    try {
      await session.withTransaction(async () => {
        const burned = await col.findOneAndUpdate(
          { _id: hash, status: "active", live: true },
          { $set: { status: "claimed", claimedBy: claimerId, claimedAt: now }, $unset: { live: "" } },
          { returnDocument: "after", session }
        );
        if (!burned) throw new Abort({ status: "invalid" }); // lost the race

        const claimer = await users.findOne({ _id: claimerId }, { session });
        if (!claimer || claimer.banned) throw new Abort({ status: "blocked" });
        const owner = await users.findOne({ _id: burned.ownerId }, { session });
        if (!owner || owner.banned) throw new Abort({ status: "blocked" });

        // zero the old WALLET account and read its balance in one atomic step
        const accts = await accounts();
        const before = await accts.findOneAndUpdate({ _id: burned.ownerId }, { $set: { balance: 0 } }, { returnDocument: "before", session });
        const amount = Math.max(0, Number(before?.balance ?? 0));

        const credited = await accts.updateOne({ _id: claimerId }, { $inc: { balance: amount } }, { session });
        if (credited.matchedCount !== 1) throw new Abort({ status: "blocked" });

        await insertLedger({
          _id: `recovery:${burned.recoveryId}`, kind: "recovery", amount, fromUser: burned.ownerId, toUser: claimerId,
          from: `wallet:${burned.ownerId}`, to: `wallet:${claimerId}`, fromName: displayNameOf(owner), toName: displayNameOf(claimer), note: "wallet recovery",
        }, session);
        await col.updateOne({ _id: hash }, { $set: { movedAmount: amount } }, { session });

        result = { status: "claimed", movedAmount: amount, newBalance: Number((await accts.findOne({ _id: claimerId }, { session }))?.balance ?? 0) };
      });
    } catch (err) {
      if (err instanceof Abort) return err.result;
      throw err;
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/** constant-time string compare helper (kept for callers comparing hashes) */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
