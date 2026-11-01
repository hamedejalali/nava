import { getDb } from "../../db/connect.js";
import { creditLedgerInSession } from "../../db/models/relic.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";

/**
 * Backgammon stake reconciliation (v1.28.0). READ-ONLY unless `apply` is true.
 *
 * Ground truth is the Jeton ledger: every stake is a `GAME_STAKE` entry with id `gstake:<gid>:<uid>` and a negative amount.
 * A stake is "closed" when `gwin:<gid>` exists (the winner got the pot) or `gstake-back:<gid>:<uid>` exists (refund).
 *   - game document MISSING + no payout ledger  → PROVABLE LOSS (the old TTL index deleted it): each payer is refunded exactly what
 *     the ledger says he paid, under the deterministic id `gstake-back:<gid>:<uid>` — running twice credits nothing more.
 *   - game finished but `settled` is not true   → reported; the normal settle()/sweep pays it, nothing to do here.
 *   - game waiting/active                       → reported only (still in play).
 */
export interface BgReconcileReport {
  scannedStakes: number;
  missingGameUnpaid: Array<{ gid: string; userId: number; amount: number }>;
  finishedUnsettled: string[];
  inPlay: string[];
  refunded: number;
}

export async function reconcileBgStakes(opts: { apply?: boolean; limit?: number } = {}): Promise<BgReconcileReport> {
  const db = await getDb();
  const ledger = db.collection<any>("relic_transactions");
  const games = db.collection<any>("bg_games");
  const rep: BgReconcileReport = { scannedStakes: 0, missingGameUnpaid: [], finishedUnsettled: [], inPlay: [], refunded: 0 };
  const stakes = await ledger.find({ type: "GAME_STAKE", _id: { $regex: /^gstake:/ } }).limit(opts.limit ?? 5000).toArray();
  const seenGames = new Set<string>();
  for (const s of stakes) {
    rep.scannedStakes++;
    const m = /^gstake:([^:]+):(\d+)$/.exec(String(s._id));
    if (!m) continue;
    const gid = m[1]!;
    const uid = Number(m[2]);
    const g = await games.findOne({ _id: gid });
    if (g) {
      if (seenGames.has(gid)) continue;
      seenGames.add(gid);
      if (g.status === "finished" && g.settled !== true) rep.finishedUnsettled.push(gid);
      else if (g.status !== "finished") rep.inPlay.push(gid);
      continue;
    }
    const closed = (await ledger.findOne({ _id: `gwin:${gid}` })) || (await ledger.findOne({ _id: `gstake-back:${gid}:${uid}` }));
    if (closed) continue;
    const paid = Math.abs(Number(s.amount) || 0);
    if (paid <= 0) continue; // unlimited-XP accounts paid nothing
    rep.missingGameUnpaid.push({ gid, userId: uid, amount: paid });
    if (opts.apply) {
      try {
        await runInTransaction(async (session) => {
          const ok = await creditLedgerInSession(`gstake-back:${gid}:${uid}`, uid, paid, "GAME_REFUND", session, { reference: `bg:${gid}`, metadata: { reconcile: true } });
          if (!ok) throw new TxAbort("already");
        });
        rep.refunded++;
      } catch (e) {
        if (!(e instanceof TxAbort)) console.error("[bg-reconcile] refund failed for", gid, e instanceof Error ? e.message : "unknown");
      }
    }
  }
  return rep;
}
