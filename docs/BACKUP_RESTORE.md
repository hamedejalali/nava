# Backup, restore and rollback runbook (v1.29.6)

**Nothing in this document was executed. A restore has NOT been tested by the engineer — do not describe it as tested until you perform it on staging.**

- The admin Excel/user export (`userExport`) is a convenience export, **not a backup**: it is not a consistent snapshot, omits collections and cannot restore balances/ledger.
- Primary backup: MongoDB Atlas Cloud Backup (continuous / snapshot). Owner must confirm it is enabled, the retention, and who can restore.
- Before any risky release: take an on-demand Atlas snapshot; note its time.
- Restore drill (staging only): restore the latest snapshot into a **new** staging cluster → point a staging deployment at it → run `npm run reconcile-ledger` → compare counts of `users`, `ledger`, key collections to the source → record the date and result here.
- Production restore decision belongs to the owner. Prefer a point-in-time restore into a NEW cluster and swapping `MONGODB_URI` over restoring in place; stop the webhook (or accept 5xx → Telegram retries) while swapping.
- Code rollback: see `docs/RELEASE_PROCESS.md`. Data is never rolled back by a code rollback.
- Ledger vs balance mismatches: `npm run reconcile-ledger` is read-only and the ledger is the source of truth; any correction is a separate, owner-approved, audited operation (not automated).
