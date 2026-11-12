# v1.30.2 — audit of v1.30.1

Tests are MOCK tests (fake MongoDB / Telegram). Nothing was run against real MongoDB, Telegram or Vercel. No load test was possible.

## A. The seven concerns — verified against the code (not assumed)
| # | Concern | Verdict | Evidence |
|---|---|---|---|
| 1 | Limiter when the DB is unavailable | Not a problem now (fixed 1.29.8): the three catch blocks use a bounded in-memory limiter with the same ceiling | `api/miniapp.ts:234,248,~303` + `src/utils/rateLimit.ts` `memoryRateLimit` (cap 5000 keys, over the cap = refuse) |
| 2 | Wallet receipt / crash recovery | Not a problem now: lease + attempt cap, marked only after the send, retry query covers rows with no log message | `src/services/wallet/walletDeposits.ts:48-49,218-225` |
| 3 | Age change vs running chats | Not a problem now: every relayed message re-checks the band | `src/features/matching/relayShared.ts:38` → `ageChangeCleanup.enforceAgeBandOnSession` |
| 4 | N+1 in Explore / DM Overview | Explore: ≤24 parallel indexed lookups (acceptable). DM overview: bounded parallel (6) | `src/services/nava/dm.ts:125` `mapLimit` |
| 5 | Legacy anon callbacks | CONFIRMED residual risk, cannot be fixed in bulk: records from v1.29.3 carry the sender's Telegram id in already-sent buttons; the notification message id was never stored. They are upgraded on first press. Only a modified client / a bot can read callback data | `src/db/models/anonMessages.ts:102-110`, `src/features/anonMessages/index.ts:235-236,368,408` |
| 6 | Stars idempotency / ledger | Not a problem now: order claim + unique `purchase:<chargeId>` + `matchedCount` check inside one transaction | `src/db/models/relic.ts:429-460` (`matchedCount !== 1` → `user_missing`) |
| 7 | Registry collisions | Not a problem now: duplicate id / action / error code throws at start-up | `src/services/games/registry.ts:55,60,67` |

## B. New verified finding
| ID | Problem | Root cause | Fix |
|---|---|---|---|
| S-01 | `hiddenOwnerIds()` — called by nearly every feed / post / story / profile / follow request — runs `users.find({$or:[{banned:true},{seedHidden:true}]})`. Neither field had ANY index, so each call scanned the whole `users` collection (the largest, always-growing one). Invisible at current size; a collection scan per request at 100k–1M users | no index (`ensureUserIndexes` had none; `grep` of all `createIndex` calls) | two **partial** indexes: `banned_users` (`banned:true`) and `seed_hidden_users` (`seedHidden:true`). They contain only banned / hidden accounts, so they cost nothing on normal writes; additive; test X1; `scripts/explain-hot-queries.ts` gets a case that must now show IXSCAN |

Index build is non-blocking on MongoDB ≥ 4.2 and tiny (few documents match). **Not verified on a real cluster.**

## C. Checked — no defect found
- Mongo connection: cached on `globalThis`, failed attempt is not cached (`src/db/connect.ts`), pool 10, bounded timeouts.
- In-memory maps: `joinedCache` (cleared over 5000), `alerted` (bounded by number of channels), `memHits` (hard cap). No unbounded growth found.
- Game join: compare-and-set on version `v` inside a transaction (`backgammonGames.join`); stakes cannot be enabled (`STAKE_SWITCH`).
- Guest authentication: initData HMAC + age limit, banned refused (`services/miniapp.ts:58-65`).
- Configuration is environment-based; no deployment URL / bot username / account id is hard-coded (grep). Premium-emoji ids are Telegram constants.
- Webhook: constant-time secret check, idempotent inbox, 5xx = redelivery, money paths use deterministic ledger ids; background work through `waitUntil`.

## D. Remaining risks / unverified (not changed)
1. **Scalability to ~1M users (not load-tested):** (a) `hiddenOwnerIds` / `lockedOwnerIds` still return every banned / private id and pass them as `$nin` arrays — fine while those sets are thousands, a design limit at hundreds of thousands (BSON 16 MB / slow `$nin`); a real fix is a design change (owner decision); (b) `pickMemberCards` reads up to 400 full user documents and a `$nin` of up to 20 000 seen ids per call; `pickCandidate` uses `$match + $sample` (scans the eligible set); (c) the free Vercel plan limits cron to daily jobs, wallet sync is driven by traffic.
2. **VPS migration:** the code is portable except the Vercel entry points (`api/*.ts`) and `waitUntil` from `@vercel/functions`. There is no long-running server entry and no SIGTERM handling because none is needed on serverless; on a VPS a small HTTP wrapper + drain-on-SIGTERM would be required. Not built (no new infrastructure). Whether `waitUntil` degrades safely outside Vercel is NOT verified.
3. Guest join via old `g_<gid>` links still skips the age-band check (owner decision, unchanged since 1.29.6). Needs approval to close.
4. Legacy anon callbacks (A.5), media signature without expiry (F-06), export/import without resume (F-16), real transactions (F-11): unchanged / not verifiable here.

## E. Migration / rollback
Only change to data structures: two partial indexes on `users` (created at cold start by `ensureUserIndexes`, idempotent). Rollback: redeploy v1.30.1 (the extra indexes are harmless) or `db.users.dropIndex("banned_users")` / `("seed_hidden_users")`. No data is touched. Deployments are per-version on Vercel; in-flight requests finish on the old build.

## F. Files of unclear purpose (not deleted)
`src/ui/cancelButton.ts` (no importer found), `src/services/brandMigration.ts` (one-off migration, only `find({}).toArray()` on `content`); `scripts/migrate-brand.ts`.
