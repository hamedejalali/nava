# v1.30.1 — audit of v1.30.0

Tests are MOCK tests (fake MongoDB / Telegram). Nothing was run against real MongoDB, Telegram or Vercel.

## A. The seven previously reported issues — re-verified against v1.30.0 code
| # | Finding | Result on current code | Evidence |
|---|---|---|---|
| 1 | Mini App limiter fail-open | FIXED in 1.29.8, still correct | `api/miniapp.ts` catch → `memoryRateLimit` same ceiling; test V1–V2 |
| 2 | Wallet receipt durability | FIXED in 1.29.8 | lease + attempts, mark after send, retry covers undefined log chat; V3–V5 |
| 3 | Age change in a running chat | FIXED in 1.29.8 | `enforceAgeBandOnSession` in the relay choke point; V6–V9 |
| 4 | N+1 in Explore / DM overview | PARTIAL by nature: Explore already parallel+indexed (≤24), DM overview bounded-parallel (6) | `mapLimit`; V10–V11 |
| 5 | Legacy anonymous-message callbacks | CONFIRMED limitation, unchanged: old messages upgrade on first press (`upgradeLegacyButtons`); their message ids were never stored, so no bulk fix | `anonMessages/index.ts` |
| 6 | Stars result / ledger | FIXED in 1.29.8 | `matchedCount !== 1` → rollback + `user_missing`; V12–V13 |
| 7 | Registry error-code collision | FIXED in 1.29.8 | duplicate code throws at start-up; V14 |

## B. New findings in v1.30.0 code (all fixed in 1.30.1, tests `v1301-audit-fixes.test.ts` W1–W6)
| ID | Problem | Root cause | Fix |
|---|---|---|---|
| N-01 | Typing `@bot ` in ANY chat created a user account, a 5-jeton starter balance and a «new user» notice to every admin | `inline_query` ran after the context-enrichment middleware (`getOrCreateUser` on every update with `from`) | the inline handler is registered BEFORE the enrichment; it only reads the user (banned / maintenance → empty list), never creates one |
| N-02 | Invite flow wrote `age` with an unconditional `$set` → two quick answers (or a stale step) could overwrite the age; name write also ignored the account state | non-atomic update | `age` written once (`age: {$exists:false}`, step not COMPLETED); name only while unfinished; stale flow on a finished account is cleared |
| N-03 | Forced name change swallowed a failed write (`.catch(()=>{})`) yet told the person «saved», and sent an admin notice per converted user (flood) | reused `applyNicknameNow` | plain awaited guarded write, no staff notice, flag cleared in the same update |
| N-04 | The name gate answered every message of a spammer (it ran before the rate limiter) | middleware order | moved behind the rate limiter |

Mutation checks: removing the `age:{$exists:false}` guard fails W3; moving the inline handler behind the enrichment fails W1/W2.

## C. Checked, no defect found
Mini App initData verification (HMAC, `timingSafeEqual`, `auth_date` age); webhook secret compare (constant time); NoSQL operator injection on id-like inputs (`unknown`-typed, `typeof string` + shape checks in `findEligibleTarget`, `setLike`, `activeStoriesOf`, `getInvite`); `transferRelicOnce` (transaction, conditional debit, unique ledger ids, recipient-missing rollback); invite token (HMAC-SHA256, 96 bits, host id not exposed; host role is decided by the authenticated id, never by the token).

## D. Remaining risks / NOT fixed (owner decision or cannot be verified here)
1. **Guest join via old `g_<gid>` links skips the age-band check** (pre-existing owner decision "guests in game join"). The NEW invite path (`ig_`) enforces it from fresh reads. Closing the old path needs approval (it would stop age-less guests from joining shared links). One-line change in `backgammonGames.join` when approved.
2. Real MongoDB transactions (F-11), cold-start index creation (F-21), Telegram behaviour of inline results and `web_app` buttons: NOT VERIFIED (mock tests only).
3. Anyone can create invite docs (rate limited 20/min per Telegram id; 24 h TTL index) — bounded, but not zero.
4. Media signature has no expiry (F-06, owner decision); export/import without resume (F-16).
5. English-only names allow look-alike names (e.g. "Admin"); not addressed (no new feature).

## E. Deployment stability (what an update does to live things)
- Active anonymous chats: untouched (the name gate skips people inside a running chat). Games: tables are rows in `bg_games`; no schema change. Payments: handled before every user-level middleware, unchanged. Wallet / ledger / background jobs: untouched.
- New data: user fields `inviteFlow`, `nicknameFixPending`; collection `game_invites` (TTL). All additive; v1.29.8 code ignores them → rollback = redeploy the previous version, no migration needed, nothing destructive.
- Serverless deploys are atomic per deployment: in-flight requests finish on the old build; Mini App clients refresh through the service-worker version (`ng-1.30.1`).

## F. Files possibly unused (owner review, NOT deleted)
`src/ui/cancelButton.ts` (no importer found). Entry points under `api/` and `scripts/` are used by Vercel / npm scripts.
