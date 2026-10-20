import { getDb } from "../../db/connect.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { creditLedgerInSession } from "../../db/models/relic.js";
import { parseXpAmount } from "./xpAmount.js";
import { resolveTransferToken, markTokenUsed, isTokenShape, hashToken } from "./transferToken.js";
import { sha256Hex } from "./walletAuth.js";

/**
 * XP CREDITING SERVICE — the ONLY code that turns a Wallet transfer into balance.
 *
 * One transfer = one immutable `xp_wallet_transfers` document (+ one ledger row) written in ONE MongoDB transaction:
 * either both exist (and the balance moved) or nothing happened. `_id` = the Wallet's transactionId, and
 * `idempotencyKey` has its own unique index, so the database itself refuses a second credit no matter how many
 * retries / parallel requests arrive. The balance is changed by the central ledger function (creditLedgerInSession),
 * never by a second implementation.
 *
 * The Wallet's fee is ignored here on purpose: Nava credits EXACTLY `amount` (the recipient's net credit).
 */

export const TRANSFERS = "xp_wallet_transfers";
const ID_RE = /^[A-Za-z0-9_.:-]{8,64}$/;

export interface WalletTransferDoc {
  _id: string; // transactionId
  idempotencyKey: string;
  keyId: string;
  userId: number;
  tokenId: string;
  requestHash: string;
  amount: number;
  walletFee?: number; // informational only — never charged by Nava
  reference?: string; // opaque wallet-side reference
  status: "completed";
  ledgerId: string;
  balanceAfter: number;
  createdAt: Date;
  completedAt: Date;
}

export type CreditError = "invalid_request" | "invalid_amount" | "invalid_token" | "token_revoked" | "user_unavailable" | "transaction_conflict" | "idempotency_conflict";

export type CreditOutcome =
  | { ok: true; duplicate: boolean; transfer: PublicTransfer; userId: number; anonId?: string }
  | { ok: false; error: CreditError; field?: string; amountError?: string };

/** What the Wallet may see about a transfer (never a Telegram id or a balance). */
export interface PublicTransfer {
  transactionId: string;
  status: "completed";
  amount: number;
  creditedAt: string;
}

const pub = (d: WalletTransferDoc): PublicTransfer => ({ transactionId: d._id, status: "completed", amount: d.amount, creditedAt: d.completedAt.toISOString() });

export interface CreditInput {
  keyId: string;
  transactionId: unknown;
  idempotencyKey: unknown;
  userToken: unknown;
  amount: unknown;
  walletFee?: unknown;
  reference?: unknown;
}

async function transfers() {
  return (await getDb()).collection<WalletTransferDoc>(TRANSFERS);
}

function replayOrConflict(existing: WalletTransferDoc, txId: string, idemKey: string, requestHash: string): CreditOutcome {
  if (existing._id === txId && existing.idempotencyKey === idemKey && existing.requestHash === requestHash) {
    return { ok: true, duplicate: true, transfer: pub(existing), userId: existing.userId };
  }
  return { ok: false, error: existing._id === txId ? "transaction_conflict" : "idempotency_conflict" };
}

export async function creditXpFromWallet(input: CreditInput): Promise<CreditOutcome> {
  const { transactionId, idempotencyKey, userToken } = input;
  if (typeof transactionId !== "string" || !ID_RE.test(transactionId)) return { ok: false, error: "invalid_request", field: "transactionId" };
  if (typeof idempotencyKey !== "string" || !ID_RE.test(idempotencyKey)) return { ok: false, error: "invalid_request", field: "idempotencyKey" };
  if (!isTokenShape(userToken)) return { ok: false, error: "invalid_token" };
  const amt = parseXpAmount(input.amount);
  if (!amt.ok) return { ok: false, error: "invalid_amount", amountError: amt.error };
  let walletFee: number | undefined;
  if (input.walletFee !== undefined && input.walletFee !== null) {
    const f = input.walletFee === 0 ? { ok: true as const, amount: 0 } : parseXpAmount(input.walletFee);
    if (!f.ok) return { ok: false, error: "invalid_request", field: "walletFee" };
    walletFee = f.amount;
  }
  const reference = typeof input.reference === "string" && /^[\x20-\x7e]{1,64}$/.test(input.reference) ? input.reference : undefined;
  if (input.reference !== undefined && input.reference !== null && reference === undefined) return { ok: false, error: "invalid_request", field: "reference" };

  // identical in a retry even if the user rotated the token meanwhile (hash of the token the Wallet was given)
  const requestHash = sha256Hex(`${hashToken(userToken)}|${amt.amount}|${idempotencyKey}`);
  const col = await transfers();

  // 1) already done? -> return the stored result, credit nothing (works even if the token was revoked afterwards)
  const prior = await col.findOne({ $or: [{ _id: transactionId }, { idempotencyKey }] } as any);
  if (prior) return replayOrConflict(prior, transactionId, idempotencyKey, requestHash);

  // 2) who is the recipient?
  const who = await resolveTransferToken(userToken);
  if (who.status === "invalid") return { ok: false, error: "invalid_token" };
  if (who.status === "revoked") return { ok: false, error: "token_revoked" };
  if (who.status !== "ok") return { ok: false, error: "user_unavailable" };
  const recipientId = who.userId;
  const tokenId = who.tokenId;

  // 3) record + credit atomically
  const now = new Date();
  const ledgerId = `walletxp:${transactionId}`;
  try {
    const doc = await runInTransaction(async (s) => {
      const balance = { v: 0 };
      const created: WalletTransferDoc = {
        _id: transactionId,
        idempotencyKey,
        keyId: input.keyId,
        userId: recipientId,
        tokenId: tokenId,
        requestHash,
        amount: amt.amount,
        ...(walletFee !== undefined ? { walletFee } : {}),
        ...(reference ? { reference } : {}),
        status: "completed",
        ledgerId,
        balanceAfter: 0,
        createdAt: now,
        completedAt: now,
      };
      await col.insertOne(created as any, { session: s });
      const credited = await creditLedgerInSession(ledgerId, recipientId, amt.amount, "WALLET_TRANSFER", s, {
        reference: transactionId,
        metadata: { keyId: input.keyId, tokenId: tokenId, ...(walletFee !== undefined ? { walletFee } : {}) },
      });
      if (!credited) throw new TxAbort("ledger_exists");
      const u: any = await (await getDb()).collection<any>("users").findOne({ _id: recipientId }, { session: s, projection: { relicBalance: 1 } });
      balance.v = u?.relicBalance ?? 0;
      await col.updateOne({ _id: transactionId }, { $set: { balanceAfter: balance.v } }, { session: s });
      return { ...created, balanceAfter: balance.v };
    });
    await markTokenUsed(tokenId);
    const u: any = await (await getDb()).collection<any>("users").findOne({ _id: recipientId }, { projection: { anonId: 1 } });
    return { ok: true, duplicate: false, transfer: pub(doc), userId: recipientId, anonId: u?.anonId };
  } catch (err: any) {
    if (err?.code === 11000) {
      // a parallel request with the same ids won the race: whatever it stored is THE result
      const winner = await col.findOne({ $or: [{ _id: transactionId }, { idempotencyKey }] } as any);
      if (winner) return replayOrConflict(winner, transactionId, idempotencyKey, requestHash);
    }
    if (err instanceof TxAbort) {
      const winner = await col.findOne({ _id: transactionId });
      if (winner) return replayOrConflict(winner, transactionId, idempotencyKey, requestHash);
    }
    if (/credit target .* does not exist/.test(String(err?.message))) return { ok: false, error: "user_unavailable" };
    throw err;
  }
}

/** Lets the Wallet resolve an uncertain outcome ("did my request go through?") safely. */
export async function getTransferStatus(transactionId: unknown): Promise<{ ok: false; error: "invalid_request" } | { ok: true; found: false } | { ok: true; found: true; transfer: PublicTransfer }> {
  if (typeof transactionId !== "string" || !ID_RE.test(transactionId)) return { ok: false, error: "invalid_request" };
  const doc = await (await transfers()).findOne({ _id: transactionId });
  return doc ? { ok: true, found: true, transfer: pub(doc) } : { ok: true, found: false };
}

/** Used by /resolve: is this token usable, and who would be credited (public Nava id + nickname only)? */
export async function describeRecipient(userToken: unknown): Promise<{ ok: true; recipient: { id: string; name: string } } | { ok: false; error: "invalid_token" | "token_revoked" | "user_unavailable" }> {
  const who = await resolveTransferToken(userToken);
  if (who.status === "invalid") return { ok: false, error: "invalid_token" };
  if (who.status === "revoked") return { ok: false, error: "token_revoked" };
  if (who.status !== "ok") return { ok: false, error: "user_unavailable" };
  const u: any = await (await getDb()).collection<any>("users").findOne({ _id: who.userId }, { projection: { anonId: 1, nickname: 1 } });
  return { ok: true, recipient: { id: u?.anonId ?? "", name: u?.nickname ?? "-" } };
}
