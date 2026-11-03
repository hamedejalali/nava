import type { ClientSession } from "mongodb";
import { chargeRelicInSession, creditLedgerInSession } from "../../db/models/relic.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";

/**
 * The ONLY way a game may touch Jeton (v1.28.1). Every movement is a ledger row with a deterministic id, so a retry / double tap /
 * redelivered request can never charge or pay twice, and `scripts/bg-reconcile`-style audits can prove what happened.
 *
 *   ledger ids:  `g:<game>:<gameId>:hold:<userId>`   (negative: chips taken)
 *                `g:<game>:<gameId>:pay:<userId>`    (positive: winnings)
 *                `g:<game>:<gameId>:back:<userId>`   (positive: refund)
 *
 * Rules a game must follow:
 *  1. Staked games are OFF unless the game's own switch says so — keep `enabled: false` until the whole flow is reviewed.
 *  2. hold() and the insert/update of the game document happen in ONE transaction (pass `session`).
 *  3. settle exactly once: guard with a `settled` flag on the game document (compare-and-set) AND the deterministic ledger ids.
 *  4. never delete a game document that holds chips (unsettled) — no TTL index on game collections.
 */
export interface GameWallet {
  /** takes `amount` from the user inside the caller's transaction; false = not enough Jeton */
  hold(userId: number, amount: number, session: ClientSession): Promise<boolean>;
  pay(userId: number, amount: number, session: ClientSession, counterpartyUserId?: number): Promise<boolean>;
  refund(userId: number, amount: number, session: ClientSession): Promise<boolean>;
  /** convenience: pay the winner the whole pot, one transaction, idempotent */
  settleWinner(winnerId: number, loserId: number, pot: number): Promise<boolean>;
  /** convenience: give every player his stake back, one transaction, idempotent */
  settleRefund(players: number[], stake: number): Promise<boolean>;
}

export function gameWallet(game: string, gameId: string, opts: { enabled: boolean }): GameWallet {
  const base = `g:${game}:${gameId}`;
  const ref = `${game}:${gameId}`;
  const assertOn = () => { if (!opts.enabled) throw new Error(`stakes are disabled for game "${game}"`); };
  const posInt = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error("amount must be a positive integer"); };
  return {
    async hold(userId, amount, session) { assertOn(); posInt(amount); return chargeRelicInSession(userId, amount, `${base}:hold:${userId}`, "GAME_STAKE", ref, session); },
    async pay(userId, amount, session, counterpartyUserId) { posInt(amount); return creditLedgerInSession(`${base}:pay:${userId}`, userId, amount, "GAME_WIN", session, { reference: ref, counterpartyUserId }); },
    async refund(userId, amount, session) { posInt(amount); return creditLedgerInSession(`${base}:back:${userId}`, userId, amount, "GAME_REFUND", session, { reference: ref }); },
    async settleWinner(winnerId, loserId, pot) {
      try { await runInTransaction(async (s) => { if (!(await creditLedgerInSession(`${base}:pay:${winnerId}`, winnerId, pot, "GAME_WIN", s, { reference: ref, counterpartyUserId: loserId }))) throw new TxAbort("already"); }); return true; }
      catch (e) { if (e instanceof TxAbort) return false; throw e; }
    },
    async settleRefund(players, stake) {
      try { await runInTransaction(async (s) => { for (const p of players) await creditLedgerInSession(`${base}:back:${p}`, p, stake, "GAME_REFUND", s, { reference: ref }); }); return true; }
      catch (e) { if (e instanceof TxAbort) return false; throw e; }
    },
  };
}
