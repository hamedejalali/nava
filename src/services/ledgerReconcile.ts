import type { Db } from "mongodb";

/**
 * v1.29.6 (F-10) — READ-ONLY ledger ↔ balance reconciliation.
 *
 * The ledger (`relic_transactions`) is the source of truth. For every user this compares
 *    SUM(amount of status "completed" rows)   with   users.relicBalance
 * and REPORTS differences. It never writes, never "fixes" a balance and never credits / debits anybody: a financial correction must be a
 * separately authorised, idempotent, transactional, audited operation (not part of this change).
 *
 * Expected, harmless differences you will see on real data (investigate, do not auto-correct):
 *  - the owner (unlimited XP: his rows have amount 0 on purpose) and default / seed members,
 *  - balances that predate the ledger (legacy opening balances) — they show up as a constant positive delta,
 *  - users who exist in the ledger only (deleted accounts).
 * Run it against a restored copy / staging database first (docs/BACKUP_RESTORE.md); on production prefer a quiet hour: the aggregation reads the whole ledger.
 */
export interface LedgerRow { userId: number; sum: number; rows: number }
export interface BalanceRow { userId: number; balance: number | null }
export interface ReconcileSource {
  ledgerSums(): AsyncIterable<LedgerRow>;
  balances(): AsyncIterable<BalanceRow>;
  nonCompletedRows(): Promise<{ pending: number; failed: number }>;
}
export interface Mismatch { userId: number; ledgerSum: number; balance: number | null; delta: number; kind: "balance_differs" | "ledger_without_user" | "user_without_ledger" }
export interface ReconcileReport {
  readOnly: true;
  usersChecked: number; matching: number; mismatching: number;
  ledgerWithoutUser: number; usersWithoutLedger: number;
  pendingRows: number; failedRows: number;
  /** largest differences first, capped (the full list is intentionally not dumped) */
  mismatches: Mismatch[]; truncated: boolean;
}

export async function reconcileLedger(src: ReconcileSource, opts: { maxListed?: number; ignoreUserIds?: number[] } = {}): Promise<ReconcileReport> {
  const maxListed = opts.maxListed ?? 100;
  const ignore = new Set(opts.ignoreUserIds ?? []);
  const sums = new Map<number, LedgerRow>();
  for await (const r of src.ledgerSums()) sums.set(r.userId, r);
  const out: Mismatch[] = [];
  let usersChecked = 0, matching = 0, ledgerWithoutUser = 0, usersWithoutLedger = 0;
  const seen = new Set<number>();
  for await (const b of src.balances()) {
    if (ignore.has(b.userId)) continue;
    seen.add(b.userId); usersChecked++;
    const l = sums.get(b.userId);
    if (!l) {
      if ((b.balance ?? 0) !== 0) { usersWithoutLedger++; out.push({ userId: b.userId, ledgerSum: 0, balance: b.balance, delta: (b.balance ?? 0), kind: "user_without_ledger" }); } else matching++;
      continue;
    }
    if (b.balance === l.sum) matching++;
    else out.push({ userId: b.userId, ledgerSum: l.sum, balance: b.balance, delta: (b.balance ?? 0) - l.sum, kind: "balance_differs" });
  }
  for (const [userId, l] of sums) {
    if (ignore.has(userId) || seen.has(userId)) continue;
    ledgerWithoutUser++;
    out.push({ userId, ledgerSum: l.sum, balance: null, delta: -l.sum, kind: "ledger_without_user" });
  }
  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const nc = await src.nonCompletedRows();
  return {
    readOnly: true, usersChecked, matching, mismatching: out.filter((m) => m.kind === "balance_differs").length,
    ledgerWithoutUser, usersWithoutLedger, pendingRows: nc.pending, failedRows: nc.failed,
    mismatches: out.slice(0, maxListed), truncated: out.length > maxListed,
  };
}

/** The MongoDB source: only `aggregate`, `find` and `countDocuments` — no write method is ever called. */
export function mongoSource(db: Db): ReconcileSource {
  return {
    async *ledgerSums() {
      const cur = db.collection("relic_transactions").aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: "$userId", sum: { $sum: "$amount" }, rows: { $sum: 1 } } },
      ], { allowDiskUse: true });
      for await (const d of cur) yield { userId: d._id as number, sum: d.sum as number, rows: d.rows as number };
    },
    async *balances() {
      const cur = db.collection("users").find({ isSeed: { $ne: true } }, { projection: { relicBalance: 1 } });
      for await (const u of cur) yield { userId: u._id as unknown as number, balance: typeof (u as any).relicBalance === "number" ? (u as any).relicBalance : null };
    },
    async nonCompletedRows() {
      const c = db.collection("relic_transactions");
      const [pending, failed] = await Promise.all([c.countDocuments({ status: "pending" }), c.countDocuments({ status: "failed" })]);
      return { pending, failed };
    },
  };
}
