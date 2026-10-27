# Nava Bot v1.16.3 — Independent Audit Report (response to the "Deep Technical Audit" prompt)

Scope: the complete project as delivered in v1.16.2. Every finding in the prompt was treated as a hypothesis and
checked against the real source before anything was changed. Where I disagreed, I say so and why.

**Honesty box (read first).**
* Every automated test in this project runs against an **in-memory MongoDB fake** (`tests/harness/fakeMongo.ts`,
  transactions emulated with undo-log rollback) and a **recording fake Telegram API** (`tests/harness/fakeTelegram.ts`).
  They are *mocked* tests. There is **no** test in this ZIP that talks to a real MongoDB or the real Telegram servers.
  The sandbox has no `mongod` and Docker is unavailable; I could not run a real database.
* Therefore guarantees that depend on real MongoDB semantics (multi-document transaction isolation, write-conflict
  retries, TTL timing, unique-index behaviour under true parallelism) are **reviewed, not proven** here. See §"What is
  guaranteed by whom".
* The deployed production environment (Vercel project settings, Atlas cluster tier, Telegram webhook configuration) was
  not accessible; nothing below claims a live deployment was verified.

---------------------------------------------------------------------------------------------------------------------

## Summary table

| # | Finding in prompt | Verdict | Status |
|---|---|---|---|
| 1 | Session close + refunds not atomic | **Confirmed** (real gap) | Fixed — one transaction, tested incl. rollback/concurrency |
| 2 | Keyboard rejected → user trapped | **Confirmed** (partly: plain fallback had no controls) | Fixed — 3-step ladder + `/end` |
| 3 | Webhook "returns 200 on failures" | **Premise false** for this code (it returned 500). Real gaps differ | Fixed — idempotent inbox, bounded retries, dead-letter |
| 4 | Failed notifications abandoned | **Confirmed** | Fixed — durable `match_deliveries` outbox |
| 5 | TTL deletes queue doc before cron notifies | **Confirmed** | Fixed — durable `search_notices` outbox |
| 6 | Financial integrity | One **real defect** found (double-tap transfer), rest sound | Fixed + reconciliation tests |
| 7 | 40 s matchmaking invocation | Works; one **real** correctness gap (no active-chat guard in match txn) | Fixed + concurrency tests; no rewrite |
| 8 | Security/config/health | No critical issue; rate limit on Mini App added | Fixed (small) + notes |
| 9 | Reproducible verification | Done in a clean copy | See "Commands executed" |

---------------------------------------------------------------------------------------------------------------------

## 1. Chat session cleanup and refund atomicity

**Observed.** `undoUnreachableMatch` (v1.16.2) ended the session (`endSessionOnce`), cleared both users'
`activeChatSessionId` in separate calls, then refunded each user via `refundChatCostOnce` — four independent writes
with no shared transaction. A crash/DB error after the first write left a closed session with unpaid refunds and,
worse, a retry saw `already_ended` and returned early — the refunds were never retried. The normal "end chat"
(`doEndChat`) had the same shape.

**Risk.** Permanently lost refunds / users left pointing at a dead session. Money-affecting, so highest priority.

**ChatGPT recommendation.** Use a transaction if the deployment supports it, else a durable state machine.

**My opinion.** Agree, transaction first. The project **already depends on multi-document transactions** for every match
(`tryMatchOnce`, `chargeChatCost`, `transferRelicOnce`, `acceptChatRequest`), so the production database must be a
replica set (Atlas). If it were a standalone server the bot could not match anyone today. I cannot verify the cluster
tier from here, but this is strong evidence. A second state machine would add complexity for no gain.

**Implementation.**
* `src/db/models/sessionClose.ts` → `closeSessionAtomic(sessionId, endedBy, refundFor, reason)`: ONE transaction that
  (a) flips `active:true → false` atomically (`findOneAndUpdate` guard), (b) unlinks each user **only if they still
  point at this session**, (c) pays the chosen refunds via `refundChatCostInSession` (ledger id
  `refund:<session>:<user>`, pre-check + unique `_id`). Any throw → full rollback → session stays active → retry works.
  A repeat call after success returns `already_ended` and credits nothing.
* `src/db/models/relic.ts`: `creditLedgerInSession`, `refundChatCostInSession` (same ledger ids as the legacy
  `refundChatCostOnce`, so a refund paid by the old path is never paid again).
* `src/features/matching/chat.ts` `doEndChat` now uses it (refund the partner only if `messageCount < 4` — unchanged rule).
* `ChatSessionDoc.endReason?` added (optional; absent on old documents).
* Failed refunds are never swallowed: the transaction throws, nothing is committed, the delivery record stays `pending`
  so the next pass retries (see §4).

**Verification (mocked).** `match-outbox.test.ts` C1 (failure mid-close rolls everything back; retry completes; third
call no-op), C2 (3 concurrent closes → exactly one `ended`, refunds once), C3 (pre-existing refund ledger row → no double
credit), C4 (refund rule), O5 (end-to-end blocked-bot path).

## 2. Chat controls when Telegram rejects a keyboard

**Observed.** v1.16.2 fell back to plain text with **no** keyboard → an active session with no visible way out.

**My opinion.** Agree. Also made the recovery independent of any keyboard.

**Implementation.** `src/features/matching/matchDelivery.ts` ladder: (1) styled controls + `<blockquote>` warning →
(2) *simple* keyboard (no `style`, no custom-emoji icons) with plain warning → (3) plain text that mentions `/end`.
Only a Telegram **4xx rejection** (not 429/5xx/network) advances the ladder. `/end` (and `/end@bot`) is handled in
`registerChatControls` for any active chat, ahead of the relay → opens the normal confirm-and-end flow.
State `degraded` records that a fallback was used. A chat is **not** ended because a keyboard failed.

**Verification (mocked).** `match-outbox.test.ts`: O1 success; O2 styled rejected → simple keyboard delivered; O3 every
keyboard rejected → plain text with `/end`, and the person then ends the chat via `/end` + confirm; O5 blocked bot;
O6 one reachable / one failing; O4/O7/O6 transient 502/429/500 (see §4). Existing `match-delivery.test.ts` (M1–M4) still passes unmodified.

## 3. Webhook errors and Telegram retry semantics

**Observed (verified in `node_modules/grammy/out/bot.js` and `api/webhook.ts`).**
* `bot.handleUpdate` **throws** a `BotError` if a handler throws; `bot.catch` is only used by `bot.start()` /
  long-polling, so **in webhook mode `bot.catch` is dead code**.
* `api/webhook.ts` returned **200 on success, 500 if `handleUpdate` threw, 503 if init failed, 401 on bad secret**.
  The prompt's claim "currently acknowledges processing failures with HTTP 200" is **not true** for this code
  (a previous release changed it to 500 deliberately). A transient DB failure therefore already led to a Telegram
  redelivery, not a lost update.
* The real gaps were different: (a) a duplicate delivery of an update that had *succeeded* (lost 200) ran all handlers
  again; (b) a deterministic bug was redelivered for as long as Telegram retries, and the user heard nothing;
  (c) two concurrent deliveries of the same update could run twice at once.

**My opinion.** I disagree with "introduce a durable inbox that stores updates": storing the update content copies
private messages and is unnecessary because **Telegram itself holds the payload and redelivers on non-2xx**. What is
missing is *bookkeeping around* that retry. I implemented exactly that.

**Implementation.** `src/webhook/processUpdate.ts` + `update_inbox` collection (metadata only: `update_id`, state,
attempts, lease; TTL 3 days). Rules: claim by `insertOne` (unique `_id = update_id`);
duplicate of `done`/`dead` → 200 without work; live-lease duplicate → 500 (come back later, not dropped); crashed
invocation (expired lease) is taken over; failure → `failed` + 500 until the attempt cap (transient causes —
Mongo network/selection, Telegram 429/5xx, `HttpError`, `TransientTransactionError` — cap 10; anything else — cap 3),
then `dead` + **200** and a one-time "please retry" notice; inbox itself unavailable → **503** (not acknowledged,
handlers not run — "acknowledged ⇒ durably accepted"). Errors are classified by the *wrapped* cause (`BotError.error`).
Handlers remain safe to re-run because all money operations are idempotent (§6).

**Limits (honest).** If Telegram's own retry window expires for an update that kept failing, that update is gone — a
Telegram limit; the dead-letter notice tells the user to repeat the action.

**Verification (mocked).** `webhook-inbox.test.ts` W1–W10 (success, duplicate, transient→retry→success, error
classification, permanent→dead-letter exactly at cap and notified once, bounded transient, concurrent duplicate,
crashed-invocation takeover, inbox unavailable → 503 and handlers not run, real bot receiving the same update twice →
one reply).

## 4. Failed connection notifications need recovery

**Observed.** `Promise.allSettled` + in-process `sendWithRetry` (3 tries, ≤1 s) then log-and-forget. After the
invocation ended nothing could recover a failed notice.

**Implementation.** `match_deliveries` outbox (`src/db/models/matchDelivery.ts`): one record per person
(`_id = <sessionId>:<userId>`) **inserted inside the match transaction** (`tryMatchOnce`, `acceptChatRequest`) — a match
cannot exist without its delivery work. States `pending → delivered | degraded | unreachable | gave_up | void`.
MongoDB lease (60 s) via atomic `findOneAndUpdate` so concurrent workers never double-send; exponential backoff
(30 s…15 min), `MAX_DELIVERY_ATTEMPTS = 8`, `foundSent` flag so a retry sends only the missing message; retries never
touch money or create sessions. `gave_up` leaves the chat open (the partner can still end it and be refunded).
Recovery runs from the next webhook request (throttled opportunistic pass) and from the cron. Terminal records TTL after 7 days.

**Hobby-plan note.** Cron is daily on Hobby, so the *time* a retry happens is driven by webhook traffic; with zero
traffic it waits for the daily cron. For tighter guarantees hit `/api/cron/expire-searches` (idempotent; Bearer
`CRON_SECRET`) from an external scheduler every 1–2 minutes — it now processes deliveries and search notices too.

**Verification (mocked).** O4 (only the missing message re-sent, no second session, no extra charge), O6 (bounded →
`gave_up`, exactly 8 attempts), O7 (429 transient), O8 (3 concurrent passes → one send), O9 (chat ended before retry →
`void`, nothing sent), O10 (chat-request path).

## 5. Search expiration, TTL and missed notifications

**Observed.** `match_queue.expiresAt` has a TTL index (`expireAfterSeconds: 0`). MongoDB's TTL monitor deletes expired
documents roughly every minute, the cron runs daily on Hobby, so the cron's "find expired and notify" would usually find
nothing. The only real notifier was the in-process countdown; if that invocation died the user was never told.

**My opinion.** Keep the TTL (it bounds storage; removing it would let abandoned entries pile up) and separate the
*promise to notify* from the queue document.

**Implementation.** `search_notices` (`src/db/models/searchNotice.ts`, `src/features/matching/searchNotices.ts`): armed
when a search is queued (id = user + that search's `createdAt`); voided atomically by match (inside the match
transaction), accept-request, cancel (`claimQueueEntry`), or a newer search. Delivery = atomic claim
(`armed → sending`, lease 90 s) so countdown / cron / webhook pass can never both notify; permanent Telegram error →
terminal `sent`; transient → back to `armed`, max 6 attempts then `gave_up`. It removes only the queue entry with the
same `createdAt` (a newer search is never touched) and stays silent for someone already in a chat. The legacy
queue-document sweep stays as a fallback and skips searches owned by a notice (no double notification).

**Verification (mocked).** `search-notices.test.ts` N1–N12 including: queue doc already TTL-deleted → still notified
exactly once; concurrent passes → once; newer search untouched; transient/blocked behaviour; countdown vs recovery
ordering both ways.

## 6. Financial integrity audit (every balance path)

| Path | Where | Idempotency / atomicity | Verdict |
|---|---|---|---|
| Initial 5 Relic | `grantInitialBalanceIfNeeded` | guarded `relicInitialized` flip + ledger `initial:<u>` in one txn | OK (F5) |
| Chat cost (match, request accept) | `chargeChatCost` in match/accept txn | `$gte` guard, ledger `chatcost:<s>:<u>` in same txn | OK |
| Refunds | `refundChatCostOnce`, `closeSessionAtomic` | ledger `refund:<s>:<u>` unique `_id` | OK (F7, C1–C3) |
| Transfers | `transferRelicOnce` | debit+credit+ledger in one txn, `transfer:<id>:debit` unique | OK **but caller defect** ↓ |
| Referral / profile bonus / report reward | `creditLedgerOnce` | ledger-first insert (unique `_id`) + `$inc` in one txn | OK (F6) |
| Stars purchase | `creditPurchaseOnce` + `stars_orders` (v1.16.1) | `purchase:<chargeId>`, order check, exceptions logged | OK (stars-payments tests) |
| Gifts | `sendGift` | gift doc + `chargeRelicInSession` in one txn, client id dedupe | OK (existing navagram tests) |
| Profile reveal | `profileReveal.ts` | `chargeRelicInSession` `reveal:<id>` | OK |
| Admin adjustment | `adminAdjustBalance` | `$gte` guard for negatives + ledger in one txn | OK (F8) |
| User import (admin xlsx) | `userImport.ts` | `$set relicBalance` from the sheet for brand-new users, **no ledger row** | Limitation, see below |
| Mining / withdrawals / mining taps | — | **do not exist in Nava** (wallet bot was separated) | N/A |

**Real defect found and fixed.** `features/matching/transfer.ts` built the transfer id with `randomUUID()` *at confirm
time*. Two taps on "تایید" (two different Telegram updates, so inbox dedupe cannot help) both read the still-existing
transfer session, got different UUIDs, and **both transferred**. Fix: the id is derived from the transfer *flow*
(`flowId` stored on the session; legacy sessions fall back to `createdAt`) so a double tap is one operation
(`already_processed`, recipient notified once). Two *legitimate* transfers use two flows → two ids; they are never merged
(there is no time-bucket dedupe anywhere in the project — verified by grep). Regression test F1 fails if the old
`randomUUID()` is restored (I checked this by temporarily reverting).

**Limitations (not changed, flagged).** (a) `creditLedgerOnce` writes the ledger row and `$inc` even if the target user
document does not exist (ledger-only credit). Reachable only if a referrer document was deleted; I left behaviour as is
to avoid changing working code, but you may want `matchedCount` checks. (b) Admin xlsx import sets balances without
ledger rows — trusted admin operation; the ledger will not reconcile for imported users. (c) Balance/ledger
reconciliation (F9) is tested on the fake only.

**What is guaranteed by whom.** MongoDB: unique `_id` (idempotency keys), atomic single-document updates (`$gte` guards),
multi-document transaction atomicity/isolation *(requires replica set — assumed from existing code, not verified)*.
Application: choice of deterministic operation ids, ordering of guarded writes, refund rules. External: Telegram Stars
payment authenticity (we only credit from `successful_payment` matched to a stored order), Telegram delivery.

## 7. Matchmaking scalability and serverless limits

**Observed.** The 40 s countdown runs via `waitUntil` after the webhook has responded (so Telegram's connection slot is
free); each active searcher holds one function instance for ≤40 s and used to open a Mongo **transaction every 2 s**
even when nobody was waiting. `tryMatchOnce` also lacked a guard on `activeChatSessionId`/`banned`: the ordered queue
deletes already prevented double matching in the normal case, but a *stale* queue entry of someone already in a chat, or a
duplicate tap, could create a second active session for the same person.

**My opinion.** Do **not** rewrite to polling-from-client: Telegram bots cannot poll, and the visible countdown is a
product feature. Bounded cost (40 s, one instance per searcher) is acceptable; fix correctness and the wasteful poll only.

**Implementation.** In-transaction guarded `updateOne({_id, banned≠true, activeChatSessionId:null}, …)` for both people
(searcher busy → new result `busy`, stale own entry removed; busy/banned candidate → their stale entry removed, retry).
Cheap non-transactional `findOne` pre-check so an idle rescan opens **no** transaction. Delivery records and notice
voiding written in the same transaction. MongoDB pool: `maxPoolSize: 10` per instance, `serverSelectionTimeoutMS: 8000`
(unchanged; review only).

**Verification (mocked).** `match-concurrency.test.ts` X1–X7 (busy searcher; stale entry; two newcomers racing for one
waiter ×20 rounds; same person tapping ×3 ×20 rounds; 30 concurrent searchers + rescans: no one in two chats, charges ==
2×sessions, every session has delivery records; banned candidate; idle rescan opens zero transactions). Mutation check:
removing the `activeChatSessionId` guard makes X1/X2 fail (X3–X5 still pass because ordered queue deletes already protect those).

## 8. Security, configuration, health

Checked: webhook secret (required, constant-time compare, 401/500 fail-secure), cron (`CRON_SECRET` required and
constant-time compared; unset ⇒ everything rejected), admin (numeric Telegram id from Telegram's update / HMAC-verified
`initData` — never client-supplied), Mini App (`initData` HMAC + max age, `banned` → 403, signed media URLs), health
(booleans + latency only; error text not exposed), env validation (lazy `required()` with clear messages).
* **Added:** per-person Mini App budget, 300 calls/min (MongoDB `rate_limits`, fails open if the limiter errors) → 429 `too_fast`.
* **Added:** `ensureRelicLedgerIndexes()` is now actually called at startup (it existed but was never invoked).
* `.gitignore` excludes `.env`, `node_modules`, `dist`, `.vercel`, logs. `.env.example` has placeholders only.
* **Secret scan** (working tree + `git log -p` of the supplied repository): no credential in source, docs, examples or git
  history. The sandbox copy of the project contains a real local `.env` (it was supplied with the upload); it is **not**
  in any ZIP and not in git. **Because it was transmitted through chat, I recommend rotating the bot token
  (BotFather `/revoke`), the Mongo user password and `WEBHOOK_SECRET`/`CRON_SECRET`** as routine hygiene. No value is reproduced here.
* Not changed (noted): request-size limits rely on Vercel's platform body limit (4.5 MB) plus `initData ≤ 4096` and
  per-field validators in the Mini App; `bot.catch` is unused in webhook mode.

## 9. Tests, dependencies, reproducible verification

Commands were run in a **clean copy** (no `node_modules`, no `.env`, no `.git`) at v1.16.3:

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | success, 277 packages |
| `npx tsc --noEmit` | exit 0, no errors |
| `npm run build` (`tsc -p tsconfig.json`) | exit 0 |
| `npm test` (`tsx --test tests/*.test.ts tests/regression/*.test.ts`) | **197 tests, 197 pass, 0 fail, 0 skipped** (~38 s) |
| `npm audit --omit=dev` | 2 moderate (transitive `uuid <11.1.1` via `exceljs`, GHSA-w5hq-g745-h8pq: bounds check in v3/v5/v6 when a `buf` is passed; `exceljs` uses uuid internally; I did not verify whether it passes a `buf`, so treat as unconfirmed-low). Fix would downgrade `exceljs` (breaking) → **not applied** |
| lint | **no lint script exists** in `package.json`; not run |
| real MongoDB / real Telegram / `vercel dev` | **could not run** (no `mongod`, Docker daemon unavailable, no network to Telegram/Atlas from the sandbox) |

Test classification: all 197 are **mocked** (in-memory Mongo fake + fake Telegram); the new `*-concurrency` tests
interleave async operations in one Node process (they model races but are not multi-process/real-DB races). There are no
live integration tests.

## Files changed (significant)

| File | Why |
|---|---|
| `src/db/models/sessionClose.ts` (new) | atomic close + refunds |
| `src/db/models/relic.ts` | in-session credit/refund helpers |
| `src/db/models/matchDelivery.ts` (new), `src/features/matching/matchDelivery.ts` (new) | durable delivery + keyboard ladder + unreachable handling |
| `src/features/matching/search.ts` | `announceMatch` → outbox; countdown timeout via notice record; `busy` result |
| `src/features/matching/engine.ts` | guards, delivery rows, notice voiding, cheap pre-check, arm notice |
| `src/services/chatRequestAccept.ts`, `src/features/matching/chatRequest.ts` | same outbox for accepted requests |
| `src/features/matching/chat.ts` | `closeSessionAtomic` in `doEndChat`; `/end` |
| `src/db/models/updateInbox.ts`, `src/webhook/processUpdate.ts` (new), `api/webhook.ts` | webhook strategy |
| `src/db/models/searchNotice.ts`, `src/features/matching/searchNotices.ts` (new), `src/db/models/matchQueue.ts`, `api/cron/expire-searches.ts` | search-timeout outbox |
| `src/db/models/transferSession.ts`, `src/features/matching/transfer.ts` | double-tap transfer fix |
| `api/miniapp.ts` | rate limit |
| `src/bot.ts` | index setup for new collections + ledger index |
| `tests/regression/*` (6 new files) | see above |
| `CHANGELOG.md`, `package.json`, `package-lock.json`, `src/config/version.ts` | v1.16.3 |

Removed export: `notifyMatch` (replaced by the durable path; only `chatRequest.ts` used it). `CHAT_REQUEST_ACCEPTED_TEXT`,
`isUnreachableError`, `isPermanentSendError` are still exported from `search.ts`.

## Migration / deployment

* **No manual migration.** New collections (`match_deliveries`, `update_inbox`, `search_notices`) and their indexes are
  created lazily at cold start (`createIndexes` is idempotent). New fields (`endReason`, `flowId`) are optional;
  documents written by v1.16.2 keep working (legacy transfer sessions and legacy queue entries are handled).
* In-flight searches during the deploy have no notice record → handled by the legacy sweep (fallback kept).
* Atlas user needs permission to create collections/indexes (already required by existing code).
* For timely retries on the Hobby plan, call `/api/cron/expire-searches` every 1–2 min from an external scheduler.
* Rollback: redeploying v1.16.2 is safe; the new collections are simply ignored.

## Regression assessment

Behaviour that **changed on purpose**: (1) a failed "found partner" notice is retried later instead of dropped;
(2) a person already in a chat who taps a search button gets "already in chat"; (3) a double tap on transfer-confirm no
longer transfers twice; (4) webhook may answer 200 for a dead-lettered or duplicate update and 503 if the inbox is
unavailable; (5) `/end` command exists; (6) Mini App returns 429 beyond 300 calls/min/person.
Unchanged and covered by the original 144 tests (all still pass unmodified): onboarding, matching, relay, admin, Stars,
Moyagram.
Residual risks: real-MongoDB behaviour untested here; inbox adds ~2 small writes per update (latency impact not measured);
retry timing on Hobby depends on traffic/external scheduler; Telegram retry window is a hard external limit.

## No secrets in the ZIP

The ZIP is built from a tree that excludes `.env`, `.git`, `node_modules`, `dist`, `.vercel`, logs; a pattern scan of
the extracted ZIP (bot-token shape, Mongo URI with password, private-key headers, live-key prefixes) is run before delivery
(result recorded in the delivery message).
