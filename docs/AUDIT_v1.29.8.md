# v1.29.8 — verification of the independent audit of v1.29.7 and the fixes

Source of truth: `nava-project-v1.29.7-audited.zip` (identical to the delivered 1.29.7 plus `docs/INDEPENDENT_AUDIT_v1.29.7.md`; checked with `diff -rq`).
All tests are MOCK tests (fake MongoDB / Telegram). No real MongoDB, replica set, Telegram or Vercel was used; production was never touched.

## 1. Findings verified against the code
| Audit | Verdict | Evidence (file, behaviour) | Action in 1.29.8 |
|---|---|---|---|
| A-01 / F-14 limiter fail-open | CONFIRMED (nuance: if MongoDB is fully down the handler's earlier user lookup fails too; the exposure is a limiter-only failure) | `api/miniapp.ts` three `catch` blocks let the call through | bounded in-memory fallback with the same ceiling (`memoryRateLimit`), logged as MG-RL-001; test V1, V2 |
| A-02 / F-07 receipt lost | CONFIRMED | `walletDeposits.ts announceCredit`: `logNotifiedAt` written BEFORE `sendMessage`; undefined log chat also left the claim; retry query only looked at `notifiedAt` | lease + attempts, mark after send, retry query covers both notices; tests V3–V5 |
| A-03 / F-08 age change in a running chat | CONFIRMED | `profileEdit.ts` set `age` directly; `relayShared.getActiveSessionAndPartner` only checked `active` | `ageChangeCleanup.enforceAgeBandOnSession` in the relay choke point + after approval; tests V6–V9 (+ mutation: without the relay check V8 fails) |
| A-04 / F-12 N+1 | PARTIALLY CONFIRMED | Explore: ≤24 per-user `limit(1)` lookups, already parallel and indexed (`mini_posts {ownerId,createdAt}`); DM overview: up to 40+40 lookups run one after another | DM: bounded parallel (6) via `mapLimit`; Explore: capped at 8 in flight. Query COUNT unchanged: a real batch (`$group`/DISTINCT_SCAN) cannot be verified without a real MongoDB `explain` → DEFERRED. Tests V10, V11 |
| A-05 media signature has no expiry | CONFIRMED (known F-06) | `services/nava/media.ts` | unchanged — owner decision |
| A-06 explain script covers 3 queries | CONFIRMED | `scripts/explain-hot-queries.ts` | added Explore, DM overview, feed queries (read-only; staging only) |
| A-07 forced wallet sync concurrency | PARTIALLY CONFIRMED | `force:true` skips the 20 s lock by design (user-triggered); double credit impossible (unique `walletdep:<id>` ledger id); `watchUserDeposit` polls every 5 s for 45 s per waiting user | unchanged, accepted; mitigation if it shows up in monitoring: per-user watch cap |
| A-08 export/import without resume | CONFIRMED (known F-16) | `userBackup.ts` | unchanged; Excel is not a backup |
| A-09 no CI workflow | CONFIRMED | no workflow file | added `.github/workflows/verify.yml` (GitHub is the host) |
| Health lists env-var presence | CONFIRMED, low | `api/health.ts` returns booleans for BOT_TOKEN / WEBHOOK_SECRET / MONGODB_URI | unchanged (useful for phone diagnosis; owner may remove the `env` block) |
| F-22 legacy anon callbacks | CONFIRMED limitation | `upgradeLegacyButtons` upgrades on first press; the notification `message_id` of old messages was never stored, so no bulk fix is possible | unchanged |
| F-18 Stars `matchedCount` | CONFIRMED | `relic.ts creditStarsPaymentOnce`: ledger row inserted, `updateOne` result ignored → ledger could say "credited" for a missing user | `matchedCount !== 1` → rollback, outcome `user_missing`, exception record + owner alert; tests V12, V13 (+ mutation) |
| F-19 registry error collision | CONFIRMED (latent: only one game registered) | `registry.ts Object.assign(errors, …)` | duplicate code throws at start-up; test V14 |
| F-24 crash after flow, before prompt | CONFIRMED (known) | recovery on next user event | unchanged |
| F-03 / F-15 raw errors | PARTIAL | not re-swept in this release | unchanged |
| F-11 real transactions, F-21 seed time | NOT VERIFIED | no real MongoDB / Vercel | unchanged |
| Rate-limit of `force` etc. | — | — | — |

## 2. Modified / new files
New: `src/services/ageChangeCleanup.ts`, `src/utils/mapLimit.ts`, `tests/regression/v1298-audit-fixes.test.ts`, `.github/workflows/verify.yml`, `docs/AUDIT_v1.29.8.md`.
Modified: `api/miniapp.ts`, `src/utils/rateLimit.ts`, `src/utils/safeLog.ts`, `src/services/wallet/walletDeposits.ts`, `src/features/matching/relayShared.ts`, `src/features/matching/profileEdit.ts`, `src/db/models/chatSession.ts` (reason union), `src/db/models/sessionClose.ts` (reason union), `src/services/nava/dm.ts`, `src/services/nava/search.ts`, `src/db/models/relic.ts`, `src/features/payments/index.ts`, `src/services/games/registry.ts`, `scripts/explain-hot-queries.ts`, `docs/ERROR_CODES.md`, `docs/CI.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `src/config/version.ts`, `public/miniapp/{core.js,sw.js,index.html}`.

## 3. Database changes and rollback
Additive and optional only: `wallet_deposits.logLeaseUntil`, `wallet_deposits.logAttempts`; `chat_sessions.endReason = "age_band"`; `stars_payment_exceptions.reason = "user_missing"`. No rename, no migration, no data rewritten. Rolling the code back leaves these fields unused; old code ignores them. One behavioural note for a rollback: a deposit whose receipt was still outstanding is simply not re-sent by the old code.

## 4. Owner decisions that remain open
Refund policy when a chat ends because of an age change (default here: <4 messages → both refunded, otherwise none — one lambda in `ageChangeCleanup.ts`); F-01; F-17; F-04 (stakes stay off); guests in game join; media signature expiry; whether to remove the `env` block from `/api/health`.
