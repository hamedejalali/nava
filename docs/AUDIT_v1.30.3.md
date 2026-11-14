# v1.30.3 — review of the `isPrivate` index (owner/auditor finding on v1.30.2)

Tests are MOCK tests. **No real MongoDB execution plan was produced in this environment** (no database access), so no performance improvement is claimed.

## 1. Verdict on the finding: the premise is not correct — the index already exists
- `lockedOwnerIds()` (`src/services/nava/common.ts:108-118`) runs `users.find({ isPrivate: true, _id: { $ne: viewerId } }, { projection: { _id: 1 } })`.
- A partial index for exactly this predicate is already defined: `{ isPrivate: 1 }`, name **`private_pages`**, `partialFilterExpression: { isPrivate: true }` — `src/services/miniappSocial.ts:55`, inside `ensureSocialIndexesOnce()`.
- It is created before any Mini App action is dispatched: `api/miniapp.ts:213` (`ensureSocialIndexesOnce()` runs on every Mini App request, once per cold start). All callers of `lockedOwnerIds` (`posts.ts`, `stories.ts`, `profile.ts`, `follow.ts`) are Mini App services, so they run behind that call. The query contains the literal `isPrivate: true`, so it satisfies the partial filter and is eligible for the index.
- The earlier S-01 note in `AUDIT_v1.30.2.md` ("isPrivate has a partial index") was correct; the gap the reviewer saw is that the index is defined in a *different file* from the other `users` indexes (`ensureUserIndexes`, `src/db/models/user.ts`).

## 2. Why no second index was added (a real risk, not just redundancy)
MongoDB refuses to create an index whose key and options equal an existing one under a **different name** (`IndexOptionsConflict`, code 85). `ensureUserIndexes()` runs inside `Promise.all` at bot initialisation (`src/bot.ts:110`); adding `{ isPrivate: 1 }` there with another name would make start-up fail on every database that already has `private_pages`. Re-declaring it under the *same* name would be harmless but adds nothing, so nothing was added. Regression test **P1** pins "exactly one index on `isPrivate`, named `private_pages`" so a later well-meant duplicate fails in CI instead of in production.

## 3. What did change
| File | Change | Why |
|---|---|---|
| `scripts/queryPlan.ts` (new) | pure helpers `planStages`, `planVerdict`, `casePasses` | the verdict is read from the real winning plan (every stage, any depth, `$or` branches, sub-plans); `COLLSCAN` anywhere = `COLLSCAN`; no stages found = `UNKNOWN`, never a pass |
| `scripts/explain-hot-queries.ts` | prints `PASS / FAIL / info` + verdict + stage chain per query; new cases `lockedOwnerIds: private pages`; a `MUST_INDEX` set (hidden owners, locked owners, explore tile, dm last message, feed) makes the script **exit with code 1** if any of them is not an `IXSCAN` on the database it is pointed at; still read-only, creates no index | the old script only printed a regex-extracted stage list and left the conclusion to the reader |
| `tests/regression/v1303-private-index.test.ts` (new) | P1 index definition (simulated: the fake records definitions only); P2 `lockedOwnerIds` behaviour (locked / followed / own / non-private / staff); P3 verdict logic on **synthetic** explain documents | see section 5 |
| version files, `CHANGELOG.md`, `docs/` | 1.30.3 | housekeeping |

No production code under `src/` or `api/` changed.

## 4. Write overhead and migration risk
- `isPrivate` is written only when someone toggles page privacy (`src/services/nava/follow.ts:145`, a rare user action). A partial index only gets an entry when the document matches `isPrivate: true`, so ordinary user writes (activity, balance, etc.) pay **no** index maintenance. No new index = no extra overhead at all.
- No migration: nothing in the database changes. Rollback: redeploy v1.30.2 (the script/test changes have no runtime effect).

## 5. Simulated vs real evidence
- **Simulated (what the test suite proves):** the index *definition* is present once and unchanged; `lockedOwnerIds` returns the right ids; the script's verdict function classifies synthetic plan documents correctly.
- **NOT verified (needs a real MongoDB):** that the planner actually picks `private_pages` for this query, the returned/examined counters, and any latency. To obtain it, the owner runs, against **staging** only: `MONGODB_URI=<staging uri> MONGODB_DB=<db> npm run explain-queries` — the case `lockedOwnerIds: private pages` must print `PASS ... IXSCAN`; the run exits 1 otherwise. (The script does not create indexes, so the staging database must have been touched by the app once so `ensureSocialIndexesOnce()` ran.)

## 6. Remaining risks (unchanged, already reported in v1.30.2)
`lockedOwnerIds()` / `hiddenOwnerIds()` still return **every** private / banned id and feed them as `$nin` lists. The index makes the *lookup* cheap; the *size of the list* is a design limit at hundreds of thousands of private accounts (BSON 16 MB, slow `$nin`). Fixing it means a design change (owner decision) and was not attempted.
