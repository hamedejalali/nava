/** v1.29.6 F-10 — read-only ledger reconciliation. Pure-logic + write-spy tests (NOT a run against a real database). */
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileLedger, mongoSource, type ReconcileSource } from "../../src/services/ledgerReconcile.js";

async function* gen<T>(a: T[]) { for (const x of a) yield x; }
const src = (ledger: any[], bal: any[], nc = { pending: 0, failed: 0 }): ReconcileSource => ({ ledgerSums: () => gen(ledger), balances: () => gen(bal), nonCompletedRows: async () => nc });

test("R1. matching balances, differing balances, ledger-only and balance-only users are classified; nothing is changed", async () => {
  const bal = [{ userId: 1, balance: 10 }, { userId: 2, balance: 7 }, { userId: 3, balance: 0 }, { userId: 4, balance: 5 }, { userId: 5, balance: null }];
  const ledger = [{ userId: 1, sum: 10, rows: 3 }, { userId: 2, sum: 4, rows: 2 }, { userId: 99, sum: 8, rows: 1 }];
  const r = await reconcileLedger(src(ledger, bal, { pending: 2, failed: 1 }));
  assert.equal(r.readOnly, true);
  assert.equal(r.usersChecked, 5);
  assert.equal(r.matching, 3, "user 1, plus the zero/absent-balance users without ledger");
  assert.equal(r.mismatching, 1);
  assert.equal(r.usersWithoutLedger, 1);
  assert.equal(r.ledgerWithoutUser, 1);
  assert.equal(r.pendingRows, 2); assert.equal(r.failedRows, 1);
  assert.deepEqual(r.mismatches.map((m) => [m.userId, m.kind, m.delta]), [[99, "ledger_without_user", -8], [4, "user_without_ledger", 5], [2, "balance_differs", 3]]);
});

test("R2. ignoreUserIds (owner with unlimited XP) and the listing cap", async () => {
  const bal = Array.from({ length: 30 }, (_, i) => ({ userId: i + 1, balance: 100 + i }));
  const r = await reconcileLedger(src([], bal), { maxListed: 5, ignoreUserIds: [1] });
  assert.equal(r.usersChecked, 29); assert.equal(r.mismatches.length, 5); assert.equal(r.truncated, true);
});

test("R3. the MongoDB source only reads: a db that throws on any write method is never asked to write", async () => {
  const writes: string[] = [];
  const guard = new Proxy({}, { get: (_t, p: string) => (...a: any[]) => { if (/insert|update|delete|replace|drop|create|bulkWrite|findOneAnd|rename/i.test(p)) { writes.push(p); throw new Error("write attempted"); } return undefined; } });
  void guard;
  const coll: any = new Proxy({}, { get: (_t, p: string) => {
    if (/insert|update|delete|replace|drop|create|bulkWrite|findOneAnd|rename/i.test(p)) return () => { writes.push(p); throw new Error("write attempted"); };
    if (p === "aggregate") return () => gen([{ _id: 1, sum: 5, rows: 1 }]);
    if (p === "find") return () => gen([{ _id: 1, relicBalance: 5 }]);
    if (p === "countDocuments") return async () => 0;
    return undefined;
  } });
  const db: any = { collection: () => coll };
  const r = await reconcileLedger(mongoSource(db));
  assert.equal(r.matching, 1);
  assert.deepEqual(writes, []);
});
