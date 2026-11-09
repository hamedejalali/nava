# MOYA / MoyaGram — Cumulative Audit History (as of v1.29.2)

This file preserves every earlier finding and every task prompt verbatim. Nothing in sections 2–4 was edited; only the resolution tracker (section 1) is updated.

## 1. Resolution tracker

| ID | Finding | Status after v1.29.2 |
|---|---|---|
| F-01 | Social surface has no age-band check | OPEN |
| F-02 | Anonymous message links ignore age band and blocks | **FIXED in v1.29.2** (mock-tested) |
| F-03 | No unique error-code system | OPEN |
| F-04 | Game wallet 'disabled' switch protects only hold | OPEN |
| F-05 | photomod:delete/ban bypass granular permissions | **FIXED in v1.29.2** (mock-tested) |
| F-06 | Signed media URLs permanent/public | OPEN |
| F-07 | Wallet deposit receipt loss / unmatched deposits | OPEN |
| F-08 | Age change doesn't close relations; relay has no re-check | OPEN |
| F-09 | Backgammon lobby not age-banded | OPEN |
| F-10 | No ledger↔balance reconciliation | OPEN |
| F-11 | Real-Mongo transaction behaviour unproven | OPEN (unverified) |
| F-12 | Hot queries at scale | OPEN |
| F-13 | Durable jobs rely on traffic / daily crons | OPEN |
| F-14 | Mini App rate limiter fails open | OPEN |
| F-15 | Raw error objects in logs | OPEN |
| F-16 | Export/import single waitUntil | OPEN |
| F-17 | Staff/official accounts bypass age separation | OPEN (needs owner decision) |
| F-18 | Stars minor hardening | OPEN |
| F-19 | Game registry isolation gaps | OPEN |
| F-20 | Public /api/health | OPEN (note only) |
| F-21 | Seed script vs 60 s limit | OPEN (unverified) |

### v1.29.2 change record (Task 2: F-05 + F-02 only)

Changed files:
- `src/features/admin/permGate.ts` — added `photomod:delete`→`users`, `photomod:ban`→`ban`.
- `src/features/photo/chatPhotoModeration.ts` — import `mayDo`; both handlers now require `isAdmin(ctx)` **and** `mayDo(ctx, <perm>)`.
- `src/features/anonMessages/index.ts` — `ANON_UNAVAILABLE_TEXT`, `mayWriteNow()` (fresh `getUser` reads, `canContact`, `isBlockedEitherWay`), applied in compose start, after force-join, on resume of a pending link, on the reply button, before rate-limit/text handling, and immediately before `createAnonMessage` in `deliver`.
- `tests/regression/v1292-anon-photomod.test.ts` — new, 22 tests.
- Version 1.29.2: `src/config/version.ts`, `package.json`, `public/miniapp/sw.js`, `public/miniapp/core.js`, `public/miniapp/index.html`, `CHANGELOG.md`; this file.

Evidence (all on the fake Mongo/Telegram harness; no real MongoDB, Telegram or Vercel was contacted):
- Focused: `npx tsx --test tests/regression/v1292-anon-photomod.test.ts` → 22/22 pass. Same tests against the unfixed v1.29.1 tree: 9 pass / 13 fail.
- Full: `npm test` → 465 tests, 465 pass, 0 fail.
- `npx tsc --noEmit` → exit 0. `npm run build` (`tsc -p tsconfig.json`) → exit 0 (output dir removed afterwards).

Residual risks: see the final report of Task 2 (non-atomic window between the last check and the insert; staff exemption in `canContact` (F-17); open anonymous chats not re-checked (F-08)).


---

## 2. Prompts, verbatim, in order

### 2.1 Request A (v1.29.0 work, Persian)

````text
@"/mnt/user-data/attachments/e4e2ec71-c530-5a84-b027-1260e9d1c484/788453ec-nava-project-v1.28.2.zip" عکس پروفایل و اسم کاربر دیگه نیازی به تایید مالک نداشته باشه
ولی یه نسخه ازش مثل قبل با همون دکمه شیشه ای ها بیاد
که هروقت من دیدم و عدم تایید زدم عکس کاربر از پروفایلش اک شه و یه پیام براش بره که به دلیل عدم رعایت
دکمه تایید هم نمیخواد بذاری براش



🪙 مدیریت ژتون 
وقتی مالک میزنه رو این دکمه
چنتا دکمه باز شه
حالا هرکدوم اسم دکمه رو خودت بذار من توضیح میدم چی کار کنه هر دکمه

دکمه اول
ارسال ژتون به کاربرانی که کمترین فعالیت رو دارن
بپرسه کاربرانی که تو چند روز اخیر فعالیت نداشتن؟
من تعداد روز رو انتخاب کنم
و به تمام اشخاصی که تو اون بازه زمانی فعالیت نداشتن ژتون ارسال کنم

بعدش تعداد ژتون به هر شخص چنتا
بعد پیامی که به اون اشخاص بعد از ارسال ژتون ارسال بشه رو بنویسم

بعد هم ارسال
دکمه دوم
ارسال ژتون بر اساس جنسیت
که دوتا دکمه دختر و پسر باشه
وقتی رو هرکدوم بزنی
ربات بپرسه
مثلا اگه رو دختر زدیم
برای تمامی دختر ها
بپرسه چند ژتون به هر دختر
بپرسه پیامی که براش ارسال شه چی باشه
بعدشم ارسال


کلا تو ارسال کلی ژتون تو چنل لاگ یدونه پیام بیاد که برا فلان تعداد به ازای هرکدوم اینقدر و کلا اینقدر ژتون با موفیقت ارسال شد


دکمه سوم
ارسال به کاربر یا کاربران که لیست یوزرنیم عددی بگیره یا یدونه
بعد بپرسه چنتا ژتون
بعد پیامی که باید ارسال شه


نکته : برای هر سه دکمه
وقتی پیام ارسال میشه 
قابلیت اینکه پیام دوم هم بعد اون پیام ارسال شه رو بتونم ایجاد کنم مثلا اول پیام اول بره بعد دومی 
هیچ پیامی با عنوان مثلا از طرف مالک شارژ شدین و اینا نمیخوام نمایش بده
ژتونشون با موفقیت شارژ شه
پیامی جز پیام های انتخابی من نمایش نده بهشون




وقتی بج انتخاب میکنی برا کاربر چرا انتخاب نمیشه براش؟ 
باگ هست درستش کن
یا وقتی بج اد میکنی به پروفایلش
همرو چک کن




عکس پروفایل کاربر داخل دکمه پروفایل
همون عکس
عکسه پیج مینی اپشون باشه
دیگه نیازی به دریافت مجدد عکس نباشه

اونایی که عکس پیشفرض دارن ولی حتما عکس گرفته شه ازشون


عکس پروفایلشون هم که پست میشه نتونن پاکش کنن
و وقتی رو سه نقطه کنار پست هم میزنن بتونن کپشن برا اون پست اولی تنظیم کنن
ولی مابقی عکسارو بتونن پاک کنن
````

### 2.2 Request B (v1.29.1 work, Persian)

````text
رو دکمه
به یه ناشناس وصلم کن

یکم کار کن
تایمر درست کار نمیکنه
وقتی دونفر همزمان میزنن رو دکمه به یه ناشناس وصلم کن و جنسیت رو انتخاب می‌کنند
ربات به باگ میخوره و برا شخص سوم که میخواد بره تو بات دکمه ای رو بزنه کار نمیکنه


از اول بررسی عمیق کن مشکلشو برطرف کن
````

### 2.3 Task 1 — read-only audit brief

````text
Hi Claude, my friend.

We are continuing the Moya / MoyaGram project.

I am the project owner and final decision-maker. ChatGPT is my senior technical architect and independent auditor. You are the engineering and implementation partner.

Task 1 — Complete Read-Only Engineering and Security Audit

Audit the attached Moya v1.29.1 project archive. Use this exact version as the baseline. Do not rely on older copies or assume that previous audit findings are still valid without checking the current source code.

IMPORTANT: This is a READ-ONLY task. Do not modify any project file.

1. Complete project discovery

Inspect the complete project, including:

- Telegram bot, webhook and update processing
- Mini App frontend and backend APIs
- Authentication, user accounts and profiles
- Anonymous matching, chat requests and messaging
- Posts, stories, feeds, discovery and social features
- Games, game registry and game sessions
- Jeton balance, ledger and transaction services
- Telegram Stars payments and external Wallet integration
- Admin panel, permissions and moderation
- Notifications, broadcast jobs and scheduled tasks
- MongoDB models, indexes, migrations and backups
- Error handling, logging, monitoring and rate limiting
- Vercel deployment configuration and environment variables

Create a dependency map showing which modules depend on shared services and which modules can operate independently.

2. Mandatory engineering requirements

Evaluate the complete project against these requirements:

A. Regression prevention and modularity

Adding or changing one feature must not break unrelated functionality.

Games must remain isolated modules. Adding a future game should require changes only to its own module and the explicitly required registry/manifest entries.

Review the boundaries between games, chat, users, payments, Jeton and shared services. Identify hidden coupling and shared-state risks.

B. Jeton integrity

The Jeton ledger must remain the single source of truth.

Audit every balance-changing operation for atomicity, idempotency, concurrency safety and consistency between the ledger and cached balances.

Game stake and wagering functionality must remain disabled. Verify that disabled functionality cannot accidentally deduct or credit Jeton through an alternate API path.

Do not enable or implement wagering.

C. Age and user safety

Audit every route through which users can discover, view, contact or interact with other users.

Verify that age-band restrictions are enforced server-side, including direct profile links, posts, stories, feeds, comments, chat requests, anonymous matching, DMs and gifts.

Unknown or invalid ages must fail closed for stranger interactions. Self-reported age must not be treated as verified age.

Identify any path that exposes users across age groups. Do not propose features that connect minors with unrelated adults.

D. Deployment continuity

A deployment, restart or migration must not corrupt active chats, games, pending payments, broadcasts, notifications or background jobs.

Identify all operations that depend on process memory, active function execution, timers or Vercel-specific background execution.

Determine whether their state and recovery mechanisms are durable in MongoDB and whether they remain reliable during interruption, restart or deployment.

Assess how the current Vercel architecture can eventually be moved to a VPS or another host without rewriting the business logic.

E. Security and administration

Verify authentication, authorization, granular admin permissions, ban enforcement, callback validation, API validation, rate limits, webhook protection, file handling and protection against replay attacks.

Check every admin action on the server. A hidden UI button is not an authorization mechanism.

F. Payments and external Wallet

Audit Telegram Stars payment processing and external Wallet deposits.

Verify that accepted payments cannot be lost, credited twice or left permanently unprocessed.

Check transaction deduplication, order claiming, deposit cursors, retries, notifications, log-channel receipts and reconciliation.

Never expose credentials or sensitive payment data in logs or reports.

G. Error logging

Check whether the project provides:

- Safe Persian user-facing error messages
- A unique error/bug code for each unexpected failure
- Timestamp, user ID, operation and relevant context
- A searchable report in the configured log channel
- Redaction of tokens, secrets and private user data
- Retry and alert controls that prevent log-channel spam

Clearly identify missing parts.

H. Scale and performance

Assess architecture for the stated target of up to one million users and hundreds of concurrent operations.

Review database connection pools, indexes, query patterns, transaction contention, rate limits, media handling, background jobs and serverless execution limits.

Do not claim the system supports this scale without actual load-test evidence.

3. Re-verify these specific v1.29.1 areas

Inspect the following particularly carefully:

1. The latest anonymous-search countdown fix, including the frozen status message, TTL timing, cancellation, simultaneous matching and the third-user scenario.
2. Whether real MongoDB transaction isolation and concurrent webhook deliveries could still produce a race not represented by the fake test harness.
3. Age restrictions in posts, stories, direct profile routes and every social-content endpoint.
4. Every method in the game wallet contract, especially the disabled-state enforcement.
5. Wallet deposit notification and receipt retry behavior, including abrupt process termination.
6. Mini App rate limiting and its behavior when MongoDB is unavailable.
7. Existing error handling versus the required unique error-code logging system.
8. Admin permission checks, Stars payment idempotency, broadcast leases and durable notification delivery.
9. Version consistency and outdated documentation or user-facing branding.
10. Vercel-specific dependencies and the reliability of active operations during deployments.

These are audit targets, not assumptions. Verify each one against the actual code and report whether it is confirmed, partially confirmed or disproven.

4. Data preservation and migration rules

Never perform a global text replacement.

Do not rename or change database names, collections, user IDs, Telegram IDs, ledger IDs, stored settings or historical identifiers without a separately approved migration plan.

Preserve owner-configured settings and all existing user data.

Any future migration must have a backup, dry-run, integrity checks and a rollback plan.

The current user-facing brand is Moya / MoyaGram, and the internal currency is Jeton. Classify outdated branding separately from internal identifiers. Do not make unapproved renames.

5. Testing and evidence

Inspect all existing tests and identify missing regression coverage.

Separate your findings into:

- Tests actually executed
- Tests inspected but not executed
- Mock-only evidence
- Real integration tests
- Load tests
- Production behavior that remains unverified

The fake MongoDB harness explicitly does not model real transaction isolation, write conflicts, TTL expiration or query-planner performance. Account for these limitations.

Never invent test results. Never claim zero bugs, complete security or production readiness without evidence.

Do not contact production Telegram, MongoDB, Wallet or Vercel services. Do not deploy anything or run destructive migrations.

6. Required report

Deliver one comprehensive report containing:

1. Project inventory and architecture
2. Complete module dependency map
3. Critical / High / Medium / Low findings
4. Exact file paths, functions and line references for every finding
5. Technical evidence and realistic impact
6. Confirmed versus unverified issues
7. Security and data-integrity assessment
8. Regression risks and missing tests
9. Deployment continuity and VPS portability assessment
10. Scale limitations and required load tests
11. Outdated documentation, branding and potentially unused components
12. A prioritized remediation roadmap

For every proposed fix, identify affected modules and possible regressions. Do not silently omit any finding because it appears difficult to fix.

Keep a cumulative audit history so future reports preserve the previous findings and their resolution status.

Final restriction

Do not implement any fixes, refactor anything, rename anything or change the database.

Return the complete report and explicitly confirm that no project source files or production data were modified.

Wait for the project owner's approval before beginning implementation.
````

### 2.4 Task 2 — fix F-05 and F-02 only

````text
Hi Claude, my friend.

ChatGPT has independently reviewed the v1.29.1 source and confirmed two findings from your audit.

Task 2 — Fix F-05 and F-02 Only

Use the exact v1.29.1 source tree as your baseline.

1. F-05 — Fix photo moderation permission bypass

In "src/features/photo/chatPhotoModeration.ts" and "src/features/admin/permGate.ts":

- Add the missing permission mapping for "photomod:delete" using the existing "users" permission.
- Add the missing permission mapping for "photomod:ban" using the existing "ban" permission.
- Keep the existing "isAdmin" checks as defense in depth.
- Ensure revoked permissions immediately prevent these callbacks from executing.
- Do not change unrelated admin permissions or moderation behavior.

2. F-02 — Enforce age separation and block rules for anonymous-message links

In "src/features/anonMessages/index.ts":

- Before allowing a user to compose a message through an anonymous-message link, verify that the sender and recipient are currently allowed to contact each other using the existing age-band policy.
- Check blocks in both directions using the project's existing canonical block-check logic.
- Repeat these checks immediately before message creation and delivery. Do not trust an earlier check or stale user objects.
- Apply the checks to both new messages and replies.
- Revalidate pending anonymous-message flows when they resume after onboarding or forced-channel membership.
- Unknown or invalid ages must fail closed for stranger contact.
- Do not create or deliver an anonymous message when either the age-band or block check fails.
- Return a safe, generic Persian user-facing response without exposing private age or block information.
- Do not create a new age policy or duplicate existing block logic.

3. Regression tests

Add focused tests covering:

F-05

- Admin with "users" permission can use photo deletion.
- Admin without "users" permission cannot use photo deletion.
- Admin with "ban" permission can use photo ban.
- Admin without "ban" permission cannot use photo ban.
- Non-admin users cannot execute either callback.

F-02

- Same-band users can use anonymous links when otherwise permitted.
- Cross-band users are rejected.
- Unknown or invalid age is rejected.
- A block in either direction prevents delivery.
- Age or block status changing after the link is opened is detected before delivery.
- Replies are subject to the same checks.
- Pending flows are revalidated when resumed.
- Failed checks do not create message records or deliver content.

4. Strict change boundaries

- Do not modify the feed, posts, stories, media URLs, game wallet, Jeton ledger, payments, deployment configuration or unrelated modules.
- Do not rename files, database collections, IDs or stored fields.
- Do not perform global string replacements.
- Preserve all existing user data and behavior outside these two fixes.
- Do not enable any game wagering or stake functionality.

5. Verification and delivery

Run the focused tests, then the complete existing test suite, typecheck and production build.

Report the actual commands and results. Clearly distinguish executed tests from tests that could not be executed.

Return:

1. The modified project archive.
2. A precise list of changed files.
3. A technical explanation of each fix.
4. Test results and regression coverage.
5. Remaining risks and unverified behavior.
6. The complete cumulative audit history, preserving all previous findings and prompts verbatim.

Do not claim real MongoDB, Telegram or Vercel verification unless actually performed.

Only implement F-05 and F-02 in this task. Do not start any other remediation.
````

---

## 3. Task 1 report (v1.29.1 audit), verbatim

> Statuses inside this report are as of v1.29.1. See section 1 for current status.

# MOYA / MoyaGram v1.29.1 — Read-Only Engineering & Security Audit

Baseline: the source tree of v1.29.1 (`BOT_VERSION = "1.29.1"`, `package.json`, `sw.js`, `core.js`, `index.html` all agree). Delivered archive: `nava-project-v1.29.1.zip`. This is the tree I built in this session; the `.txt` brief is the only attachment of this task (the only zip in the attachments folder is the older v1.28.2).

**Read-only confirmation:** during this audit no project file was written, renamed or deleted (a `find -newer` against the delivered v1.29.1 zip lists nothing). No production Telegram / MongoDB / Wallet / Vercel service was contacted, nothing was deployed, no migration was run. This report file lives outside the project.

**How this audit was done (be aware of the limits):** code reading of the current source + the existing test inventory. Four parts were first delegated to sub-readers; two of them (Jeton/games/Stars/Wallet and admin/security) were cut off by a usage limit, so I re-did those parts myself directly in the source. Items that I read line-by-line are marked **READ**; items that came from a sub-reader and that I did not re-read myself are marked **REPORTED**; everything that needs production or a real replica set is **UNVERIFIED**. I did **not** re-run the test suite in this read-only task (the last run — `tsc --noEmit` clean, `npm test` 443/443 pass on the fake harness — was at v1.29.1 delivery, earlier in this session).

---

## 1. Project inventory and architecture

| Area | Files (approx.) | Notes |
|---|---|---|
| Runtime entry points | `api/webhook.ts`, `api/miniapp.ts` (621 l), `api/monitor.ts`, `api/health.ts`, `api/cron/expire-searches.ts`, `api/cron/process-broadcasts.ts` | Vercel Node functions; `webhook` 512 MB / 60 s; both crons **daily** (`vercel.json`) |
| Bot (grammY) | `src/bot.ts`, `src/features/*` (95 files, ~11.7k lines) | middleware chain: payments → ban → onboarding → rate limit → features |
| Services | `src/services/*` (57 files, ~7.9k lines) | Mini App social layer (`nava/*`), games, wallet, seeds, broadcast, monitor, jetonMass |
| Persistence | `src/db/*` (35 files, ~3.9k lines) | MongoDB driver 6.x, `maxPoolSize: 10`, `serverSelectionTimeoutMS: 8000`; models + `tx.ts` (`runInTransaction`) |
| Mini App frontend | `public/miniapp/*` (40 files), `public/monitor/*` | static JS, service worker `sw.js`, signed-initData auth |
| Tests | `tests/` — 62 files under `tests/regression`, harness `tests/harness/fakeMongo.ts` + `fakeTelegram.ts` | 443 test cases reported by the runner |
| Ops scripts | `scripts/` (`set-webhook`, `bg-reconcile`, `migrate-brand`, …), `tools/` (build-time badge/city generators) | |
| Docs | `docs/` (`AUDIT_v1.16.1…v1.28.0`, `DATA_SAFETY`, `WALLET_API`, `ADD_A_GAME`, `GIFT_PACK`), `README_FA/EN.md`, `CHANGELOG.md` | |

### Durable-state patterns used (good)
Update inbox with 60 s lease + dead-letter (`src/webhook/processUpdate.ts`); deterministic ledger ids (`creditLedgerOnce`, `creditLedgerInSession`); lease + CAS cursor jobs (`broadcast_jobs`, `jeton_jobs`); durable outboxes (`match_deliveries`, `search_notices`); Mongo-backed rate limiter (`src/utils/rateLimit.ts`); Mongo-backed admin flow state.

---

## 2. Module dependency map

```
                         ┌────────────────────────── api/webhook.ts ──────────────────────────┐
Telegram ──secret──►     │ processUpdateOnce (inbox) → bot.ts middleware chain                 │
                         │  payments ► ban ► onboarding ► rateLimit ► features/*               │
                         └─ waitUntil: monitor metric, deliveries, search notices, gift events,│
                            seed jobs, wallet sync (5-6 background tasks per request)          │
Mini App ──initData HMAC─► api/miniapp.ts ► services/nava/* (social) ┐                          │
                                           ► services/games/*       ├─► db/models/* ─► MongoDB │
Cron (daily) ─Bearer─►  expire-searches / process-broadcasts ────────┘                          │

SHARED SERVICES (everything depends on these)                 CAN OPERATE (mostly) INDEPENDENTLY
 db/connect.ts, db/tx.ts                                       services/games/<id> (via registry + gameWallet)
 db/models/user.ts (users: balance, age, ban, flags)           services/wallet/* (client + deposits; only needs relic.creditLedgerInSession)
 db/models/relic.ts (ledger = single write path)               services/sightengine.ts, telegramFiles.ts
 services/ageBand.ts (stranger-contact rule)                   services/jetonMass.ts + jetonJobs (needs relic only)
 services/channelRouting.ts (log/receipt chats)                services/broadcastProcessor.ts
 features/admin/permGate.ts + permissions.ts                   public/monitor (staff only)
 utils/rateLimit.ts, utils/secureCompare.ts
```

Hidden couplings found (see findings): `api/cron/expire-searches.ts` hosts the game sweep (L75) and the search expiry; `features/games/shareStart.ts` imports `backgammonGames.inviteInfo` directly; the game registry merges **all games' error→HTTP maps into one global object**; `users` is simultaneously profile store, balance store, match state (`activeChatSessionId`) and moderation state, so every module contends on the same document type; `relicBalance` is written by 9 distinct functions in `relic.ts` plus 2 outside it (`userImport.ts`, `grantInitialBalanceIfNeeded` is inside).

---

## 3. Findings

Severity legend — **Critical** = proven exploitable loss/exposure now; **High**; **Medium**; **Low**. *No Critical finding was proven in this audit.* Status: CONFIRMED / PARTIALLY CONFIRMED / DISPROVEN / UNVERIFIED. Evidence tag: READ (I read the lines), REPORTED (sub-reader, not re-read).

### HIGH

**F-01 — Social surface has no age-band check (profiles, feed, posts, stories, comments, story replies, likes, follow, photo).** CONFIRMED (REPORTED, spot-checked: `eligibleCandidateFilter` in `src/services/miniapp.ts:89-99` has no age term, READ).
- `src/services/nava/common.ts:~203 findVisibleUser` filters only blocked/banned/hidden; used by `api/miniapp.ts` profile action, `nava/profile.ts getProfile (~75)`, `nava/follow.ts`, `listUserPosts`. `nava/posts.ts listFeed (~122)`, `getPostItem (~160)`, `addComment (~440)`, `nava/stories.ts replyToStory (~210)` (free-text to the owner), `setFollow` — none apply the band. `nava/profile.ts:~90` returns `age` (unless hidden), city, province. `api/miniapp.ts` `photo` action → `findEligibleTarget` → no band.
- Impact: any user can open any profile by `anonId` (ids leak through feed/comment authors) and send free text through comments/story replies across the 18-year line. This is exactly the exposure brief §C forbids. The v1.28.0 audit listed it as a "remaining risk" with narrower wording; it is wider (comments and story replies are direct text channels).
- Fix (needs a product decision first): one shared helper in `nava/common.ts` (`ageBandDiscoveryFilter` exists at `common.ts:138` and `canContact` in `ageBand.ts`) applied to feed, explore, profile, posts, stories, comments, likes, follow, follow lists, story replies, media GET routes. Unknown age ⇒ fail closed. Decide: hide cross-band content entirely, or read-only + block interaction.
- Regression risk: whole Mini App social surface; users with unknown age would see an empty feed; follows/notifications that already exist across bands need a cleanup policy.

**F-02 — Anonymous message links ignore age band and blocks.** CONFIRMED (REPORTED). `src/features/anonMessages/index.ts:128-148` (`/start` handler) → `beginCompose (:62)` → `deliver (:89)` checks only `!target || target.banned`; no `canContact`, no `isBlockedEitherWay`; `grep` for age/band/canContact in that folder and `db/models/anonMessages.ts` finds nothing. Impact: free-text from a possibly-unknown-age anonymous sender to anyone with a link, across bands. Fix: `canContact(sender,target)` + block check in `beginCompose` and `deliver` (also replies). Low regression risk (this feature only).

**F-03 — Required error-code system does not exist (brief item G).** CONFIRMED (REPORTED; the three catch points re-checked in my own reading: `api/webhook.ts` `notifyDeadUpdate` sends a fixed Persian string; `bot.catch` in `src/bot.ts:352-367`; `processUpdate.ts:90-120`).
- No unique bug code anywhere (grep errorCode/bugCode/errorId/ERR- = 0 hits). No error ever reaches the log channel (`getLogChatId` is used only by wallet receipts, admin audit, jeton summary). User messages are three different generic strings, no reference code. Log lines carry `err.name` only (privacy-friendly, but no operation/userId/stack). `bot.ts:357` and `db/connect.ts:70` and `api/health.ts` print the **raw error object** (Mongo errors can embed the connection string — redaction is by convention, not by a helper). Alert anti-spam exists only for monitor conditions (`monitor.ts:208-276 claimSlot`).
- Missing parts, in order: code generator (time + random), central `reportError(op, userId, err, ctx)` with redaction, `error_reports` collection + a log-channel purpose in `channelRouting.ts`, fingerprint dedupe with cooldown, user-visible code in `bot.catch`, `notifyDeadUpdate` and Mini App 500s. Risk: low if fire-and-forget and try/caught.

**F-04 — Game wallet contract: the "disabled" switch protects only `hold`.** CONFIRMED at contract level (READ: `src/services/games/wallet.ts`).
- `assertOn()` is called only in `hold()`. `pay()`, `refund()`, `settleWinner(winnerId, loserId, pot)` and `settleRefund(players, stake)` do **not** check `opts.enabled`, and `settleWinner` credits an arbitrary `pot` without verifying that matching `hold` ledger rows exist (a mint if a game module passes a wrong amount). `refund`/`settleRefund` likewise never verify a prior hold. `settleRefund` returns `true` even if every row already existed. The comment says "stakes OFF unless the game's switch says so", but a module with `enabled:false` can still credit Jeton through four of five methods.
- Exploitability today: **not found** — the only current game (`backgammonGames.ts`) gates creation (`:406`, `STAKE_SWITCH`), join (`:439`) and settles only `stake > 0 && !settled` games (`:187-195`); I found no HTTP action that reaches `pay`/`settle*` with stake 0. So: contract weakness confirmed, live exploit unproven. A future game that trusts the contract could mint Jeton.
- Fix: `assertOn()` in all methods; `pay/settleWinner` must verify holds (`g:<game>:<id>:hold:*` rows sum == pot) in the same transaction; `refund` must verify the hold exists. Affects `services/games/*` only; regression risk: the settlement of pre-existing staked backgammon games (kept alive by `STAKE_SWITCH` tests) — needs the existing `v128-game-stakes-off` tests extended first.

### MEDIUM

**F-05 — `photomod:delete` / `photomod:ban` bypass granular admin permissions.** CONFIRMED (READ). `src/features/photo/chatPhotoModeration.ts:125,157`: handlers check only `isAdmin(ctx)`. The prefix `photomod:` is **not in `CALLBACK_PERMS`** and does not start with `admin:`/`adm:`, so `callbackNeed()` returns `null` and the permission gate (`src/features/admin/permGate.ts`) does not run. An admin whose "ban" right was switched off can still ban a user through an old/forwarded `photomod:ban:<id>` button (`banUser(...)` at `:165`). Fix: add `["photomod:delete","users"], ["photomod:ban","ban"]` to the table. Also note the gate's default for unknown `admin:`/`adm:` prefixes is "any admin" (fail-open within admins), not deny — acceptable but worth tightening. `pcr:` and `grc:` are user-flow callbacks, not admin ones (OK).

**F-06 — Signed media URLs are permanent, public, and CDN-cached for a year.** CONFIRMED (READ: `api/miniapp.ts serveImage ~150-190`, `services/nava/media.ts:60-64`). `GET ?m=<id>&s=<hmac>` and `?u=<anonId>&s=<hmac>` have no viewer, no expiry, no band; response `Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable`. Consequences: (a) a photo removed by the v1.29.0 «عدم تأیید» revoke, a ban, or a deletion stays served from the edge cache under its old URL for up to a year; (b) anyone holding a signed link (forwarded, scraped) can see the image regardless of age band/block; (c) the `u:` route signs the `anonId` only, so the same signature is valid for every future photo of that user (version `v` is not signed). Also no rate limit on this GET route; each cache miss costs a Telegram `getFile` + download. Fix: include version/expiry in the signature, `private`/short TTL for profile photos, and revalidate on revoke. Risk: Mini App caching behaviour + service worker.

**F-07 — Wallet deposit receipt can be lost on abrupt termination; unmatched deposits have no resolution path.** CONFIRMED (READ: `src/services/wallet/walletDeposits.ts`).
- `announceCredit` sets `logNotifiedAt` **before** sending the log-channel receipt (`logClaim` update, then `sendMessage`). If the process dies between them the receipt is never sent: `retryPendingAnnouncements` selects only rows with `notifiedAt` missing, so a row whose user was notified but whose receipt was claimed-not-sent is never retried. (The user notice itself is correct: lease → send → `notifiedAt`; a crash after send but before the flag gives a duplicate notice after the 60 s lease, benign.)
- `creditTransfer` for `user_missing`/`invalid` writes `wallet_unmatched` and `alertAdmins` is a single best-effort `sendMessage(...).catch(()=>{})`; the cursor then moves past the transfer, so the alert is never repeated and nothing in `src` reads `wallet_unmatched` (grep: only the writer). Money that never matched stays unresolved without a tool.
- The credit itself is sound: one transaction inserts `wallet_deposits{_id: tx.id}` + ledger `walletdep:<id>` + balance; duplicates abort. Cursor semantics (inclusive `completed_after`, equal-timestamp boundary, late-completing transfers) depend on the real Wallet API — **UNVERIFIED**.
- Fix: write `logNotifiedAt` after success (or a lease like the user notice); add a retry source for "notified but no receipt"; persist and re-alert unmatched deposits and give owner a resolve action.

**F-08 — Age changes do not close existing relations; bot relay has no band re-check.** CONFIRMED (REPORTED). `features/matching/chat.ts`, `mediaRelay.ts`, `relayShared.ts` have no `canContact`; DMs re-check on every send (`nava/dm.ts:258 usable`) and chat-request accept re-checks (`chatRequestAccept.ts:60`) — good — but an open anonymous chat keeps relaying after a user edits age across 18. Age is self-reported (`miniOnboarding.ts:73`, `profile.ts:194`, 9–99; changes go to owner approval at `profile.ts:197` — approval is not verification). Fix: re-check on relay + end the session on band flip; rate-limit age edits; audit-log crossing 18.

**F-09 — Backgammon lobby/join is not age-banded.** CONFIRMED (REPORTED). `services/games/backgammonGames.ts:351 lobby`, `:426 join`, `features/games/shareStart.ts` → `inviteInfo`. Stakes are off and no free-text channel was seen in the game; the opponent brief links to profiles (F-01). Fix in the shared game layer, not per game.

**F-10 — No ledger↔balance reconciliation; direct balance writes outside the ledger.** CONFIRMED (READ). Only `scripts/bg-reconcile.ts` (games) exists. `src/services/userImport.ts:190` writes `relicBalance` straight from a spreadsheet cell for a *new* telegramId with no ledger row (documented as restore); `userExport` writes balances out. All other credit/debit paths I enumerated are ledger-paired and in a transaction (see §7). Impact: if any path ever diverges, nothing detects it. Fix: a read-only reconcile script (sum ledger per user vs `relicBalance`), then a scheduled report.

**F-11 — Real-MongoDB transaction behaviour is unproven (brief target 2).** UNVERIFIED (design risks READ). `src/db/tx.ts`/`engine.ts` use `withTransaction` with the driver default retry window (≈120 s) and no `timeoutMS`/`maxCommitTimeMS`; a contended transaction can hold a webhook invocation to its 60 s `maxDuration`, while the inbox lease is also 60 s, so a slow first delivery can be reclaimed and processed concurrently. Business handlers are designed idempotent (deterministic ids), but this was never exercised on a replica set. `maxPoolSize: 10` per instance is the first likely bottleneck (each tx + each countdown tick + 5-6 `waitUntil` tasks per webhook).

**F-12 — Scale: hot queries that cannot scale to 1M users.** CONFIRMED by code (REPORTED): unanchored case-insensitive regex user search on `users` (`features/search/userSearch.ts:130-132`, `nava/search.ts:71-77,112`; no nickname index by design, `user.ts:160-164`); skip pagination (`nava/search.ts:27`, `userSearch.ts:112`, `user.ts:513,526`, `seeds.ts:109`); 48 `countDocuments`; no index on `lastActivityAt`/gender/age/province although jeton-mass recipient filters and discovery use them; Mini App `pulse` fans out ≥6 queries per poll (`api/miniapp.ts:433-447`); photos fetched from Telegram per request, no object store/CDN origin. **No load test exists.** No scale claim can be made.

**F-13 — Durable jobs rely on traffic or daily crons on Vercel.** CONFIRMED (READ `vercel.json`, `api/webhook.ts:128-132`). Both crons are daily (00:00/01:00). Search timeout notices, delivery retries, gift events, seed jobs and wallet sync advance opportunistically from webhook traffic; if traffic stops, recovery waits for the daily cron. The state is durable (good), the latency is not. README claims "every 2 minutes" (stale, F-18). If `CRON_SECRET` is unset both crons answer 401 forever and nothing alerts (`api/cron/*:12/37`).

**F-14 — Mini App rate limiter fails open.** CONFIRMED (READ `api/miniapp.ts` ~226-243, 296-300). By design ("a limiter outage never locks everybody out"): if `checkRateLimit` throws, the request proceeds. The bot path (`bot.ts:255-275`) fails closed in effect (DB needed earlier). Budget is per-user only (no per-IP) and the media GET has none. Impact is an abuse window only while Mongo is partially degraded. Fix: bounded in-memory fallback.

**F-15 — Raw error objects in logs (redaction by convention).** CONFIRMED (READ): `bot.ts:357`, `db/connect.ts:70`, `api/health.ts` ("full error (message AND stack) is still logged"). Mongo/grammY errors can embed a URI or request payload. Part of F-03's fix.

**F-16 — Export/import run inside one `waitUntil`, no resume.** PARTIALLY CONFIRMED (READ `features/admin/userBackup.ts:53,92`; REPORTED streaming). A large import/export can exceed 60 s and be killed; import rows are idempotent per user but the job has no checkpoint and the lock (`exportJobLock`) recovery was not verified.

### LOW

**F-17 — Staff and "official" accounts bypass the age separation** (`ageBand.ts:34-35`, `common.ts:138`). Intentional for moderation; a compromised admin bypasses all separation. Needs owner sign-off + audit logging of cross-band staff contact.

**F-18 — Stars: minor hardening items.** `creditStarsPaymentOnce` (`relic.ts:428-460`) is correct (order claim + ledger `purchase:<chargeId>` + balance in one transaction; duplicate/consumed outcomes; payments composer precedes the ban middleware at `bot.ts:190-197`; pre-checkout validates amount/currency/pending order). Remaining: (a) the final `updateOne` credit does not check `matchedCount` (unlike `creditLedgerInSession`), so a missing user would leave a ledger row without a balance; (b) the owner alert for exceptions is a single best-effort `sendMessage(...).catch`, the durable record (`stars_payment_exceptions`) is the real safety net but nothing lists it in the panel (grep: only the writer); (c) legacy payload `relic:<index>` is priced from the live package list; (d) no sweeper for long-pending `stars_orders`, no Telegram refund flow; (e) on a failure *after* credit (reply fails) Telegram redelivers and the duplicate path returns silently — user may miss the confirmation.

**F-19 — Game registry isolation gaps.** `buildRegistry` (`services/games/registry.ts`) merges every module's `errors` with `Object.assign` and no collision check — a new game can silently override another game's error→HTTP mapping; `GameModule` has no enforced boundary against importing `relic.ts` directly (the wallet rule is documentation); `features/games/shareStart.ts` is backgammon-specific, so `/start g_<id>` links don't derive from the registry; the sweep is wired through `api/cron/expire-searches.ts:75`. Adding a game therefore needs more than "module + one line" for share links.

**F-20 — Public `/api/health`** returns env-presence booleans and Mongo latency (no values). Low information exposure; acceptable, note only.

**F-21 — Seed (default-member) script can pass the 60 s function limit** (`search.ts SEED_SCRIPT_BUDGET_MS` = 55 s from press; matched at ~37 s + 10–20 s script). Recovery (`processDueSeedJobs`, `settleDueSeedChat`) exists and is designed for this; not proven on real Vercel.

---

## 4. Re-verification of the 10 specified v1.29.1 targets

| # | Target | Verdict | Notes |
|---|---|---|---|
| 1 | Search countdown fix (frozen message, TTL timing, cancel, simultaneous, third user) | **Confirmed fixed in logic; production unverified** | v1.29.1: countdown clock from press time (`search.ts runCountdown`: `clockStart`, `deadline`), grid ticks, `dropOwnStatus` on every end path, TTL fallback via `hasArmedNoticeFor`/`claimArmedSearchNoticeFor`, 400-on-edit no longer kills the search. 8 tests in `v1291-search.test.ts` (fake Mongo). The **"third user's buttons don't work" symptom was never reproduced**; I found no shared document in a third user's request path. Candidate causes stay hypotheses: pool saturation (10), long `withTransaction` retry occupying an invocation, cold-start `ensure*Indexes` taking locks while transactions are open, non-Fluid Vercel spawning many cold instances. Needs Vercel runtime logs from the incident (`[nava:webhook]`, `[search]`). UNVERIFIED |
| 2 | Races a real replica set could still produce | **Partially confirmed (risk), none demonstrated** | F-11. Specific: loser of the first ordered delete retries and may briefly see its own entry as still queued → status message + countdown start; now cleaned by the countdown. Double-press with stale `ctx.dbUser` (`search.ts:~232,339`) is mitigated, not proven. TTL monitor timing now harmless on paper. |
| 3 | Age restrictions in posts/stories/direct profile/social endpoints | **Confirmed gaps** | F-01, F-02, F-09. Contact/discovery routes verified enforced: matching (`search.ts:262`, `engine.ts:89,92,169`, `matchQueue.ts:189`), seeds (`seedMatch.ts:106,125`, `seeds.ts:218`), chat requests (`chatRequest.ts:69`, `chatRequestAccept.ts:60`), DMs (`dm.ts:258-264`), gifts (`gifts.ts:137,212`, `giftReply.ts:77`), search (`userSearch.ts:58,187,302,324`, `nava/search.ts:25,116`), match cards (`matchCards.ts:99`). Unknown/invalid age fails closed in `ageBand.ts:15-38` (READ by sub-reader). |
| 4 | Game wallet contract, disabled state | **Partially confirmed** | F-04 (contract); backgammon create/join/settle gating verified (`backgammonGames.ts:49,406,439,187`). |
| 5 | Wallet deposit notification/receipt retry, abrupt termination | **Partially confirmed** | F-07. |
| 6 | Mini App rate limiting when MongoDB unavailable | **Confirmed fail-open** | F-14. |
| 7 | Error handling vs required unique error codes | **Confirmed missing** | F-03, F-15. |
| 8 | Admin perms, Stars idempotency, broadcast leases, durable delivery | Admin: **gap found** (F-05). Stars idempotency: **disproven as a problem** (F-18 notes). Broadcast leases & jeton-mass leases: tests exist (`v128-broadcast-lease`, `v129-features` J1–J4); I did not re-read `broadcastProcessor.ts` in this audit → **not re-verified**. Delivery outboxes: designed durable; recovery latency per F-13. |
| 9 | Version consistency, outdated docs/branding | **Confirmed** | §11. Runtime version strings consistent at 1.29.1. |
| 10 | Vercel dependencies / reliability during deploy | **Confirmed dependencies, state durable** | §9. |

---

## 5. Security & data-integrity assessment

**Verified good (READ unless noted):**
- Webhook: constant-time secret compare (`api/webhook.ts`, `utils/secureCompare.ts`), 401 on mismatch, update-id inbox with lease, bounded retries, dead-letter, 5xx → Telegram redelivery.
- Cron auth: `Bearer CRON_SECRET`, constant-time, fail-closed if unset.
- Mini App auth: HMAC `initData` with max age (`verifyTelegramWebAppInitData`, `MINIAPP_INITDATA_MAX_AGE_SECONDS`), staff re-authenticated from the DB per request (v1.28; `authenticateStaff`), `actAs` limited to staff with `seeds` right.
- Every balance path I enumerated is transactional and ledger-paired with a deterministic id (list in §7).
- Stars: order claim + ledger + balance in one transaction; replay/forward → exception record, no second credit; payments handled before ban middleware.
- Wallet: credit uses `delivered_amount`, only `COMPLETED`, unique tx id, bounds (`MAX_XP_AMOUNT`).
- Secrets: bot token is used server-side only (`downloadTelegramFile`); Sightengine receives bytes, not a token URL (v1.28 fix, REPORTED, not re-read).
- Permission gate covers labels, old inline buttons and running flows (`permGate.ts`).

**Gaps:** F-01, F-02, F-05, F-06, F-07, F-08, F-10, F-14, F-15. Age is self-reported everywhere; nothing in the code treats it as verified except that cross-band separation trusts it.

**Not audited in depth (be explicit):** `Sightengine` moderation internals, `userExport/userImport` authorization details, file upload validation in `nava/media.ts` (size/type), CORS/headers of `api/monitor.ts`, `broadcastProcessor.ts`, `jetonMass.ts` internals beyond the v1.29 tests, all `public/miniapp/*.js` client code (XSS surface), `scripts/*`.

---

## 6. Regression risks & missing tests

Missing coverage (none of these exists today):
1. Age band on posts/stories/comments/story replies/follow/profile route/photo action and on anon-message links (F-01/F-02) — tests currently cover contact paths only (`v128-age-separation`, 11 tests).
2. `gameWallet.pay/refund/settle*` with `enabled:false`, and hold-verification (F-04) — `v128-game-stakes-off` covers creation/join/legacy settlement.
3. `photomod:*` with a revoked `ban` right (F-05); permission-table completeness test (every registered `callbackQuery` prefix must map to a need or an explicit "user flow" allow-list).
4. Abrupt termination between claim and send for wallet receipts, jeton summary and match deliveries (kill-point tests).
5. Signed-media expiry/revocation behaviour.
6. Age flip during an open anonymous chat.
7. Anything against a real MongoDB replica set: write conflicts, transaction retry duration, TTL timing, lock waits during `createIndexes`.
8. Error-code reporting (does not exist).

Regression risks of the proposed fixes are given per finding; the broadest are F-01 (whole social UI), F-06 (caching/service-worker), F-04 (legacy staked-game settlement).

---

## 7. Jeton integrity — enumerated balance-changing paths (READ)

| Path | Function | Atomic with ledger? | Idempotent id |
|---|---|---|---|
| Signup bonus | `grantInitialBalanceIfNeeded` (`relic.ts:~183`) | yes (flag flip + ledger in one tx) | `initial:<uid>` |
| Chat cost | `chargeChatCost` (`:235`) in match tx | yes, balance-guarded | `chatcost:<sid>:<uid>` |
| Chat refund | `refundChatCostOnce` / `…InSession` | yes | `refund:<sid>:<uid>` |
| Generic charge in tx | `chargeRelicInSession` (`:265`) | yes, guarded | caller's id |
| Gift transfer | `relic.ts:~336-344` | yes, debit+credit | per gift |
| Credit once | `creditLedgerOnce` (`:122`), `creditLedgerInSession` (`:559`) | yes | caller's id |
| Purchases (Stars) | `creditStarsPaymentOnce` (`:428`) | yes + order claim | `purchase:<chargeId>` |
| Referral/profile/report rewards | `:472,483,492` | yes | `referral:<uid>`, `profilebonus:<uid>`, `report:<id>` |
| Admin adjust | `adminAdjustBalance` (`:~495`) | yes | `admin:<uuid>` (not replay-protected by design) |
| Admin bulk | `creditAdminBulkOnce` | yes | `jetonmass:<job>:<uid>` |
| Wallet deposit | `creditTransfer` | yes | `walletdep:<txid>` + unique deposit row |
| Games | `gameWallet` | holds yes; `pay/refund/settle*` see F-04 | `g:<game>:<id>:hold|pay|back:<uid>` |
| **User import (new telegramId)** | `userImport.ts:190` | **no ledger row** | n/a — F-10 |

Disabled stakes: create/join are refused server-side (`backgammonGames.ts:406,439`, `STAKE_SWITCH.enabled = false`); legacy staked tables are only closed/refunded. No alternate API action reaching `hold` was found; the contract weakness is F-04.

---

## 8. Test evidence

| Category | Evidence |
|---|---|
| **Tests actually executed** | Earlier in this session on v1.29.1: `npx tsc --noEmit` clean; `npm test` → 443 tests, 443 pass, 0 fail (`tests/*.test.ts` + `tests/regression/*.test.ts`). Not re-run during this read-only audit. |
| Tests inspected, not executed in this audit | all of `tests/` (62 regression files); I read headers/specific cases only where cited. |
| **Mock-only evidence** | **All of the 443.** They run on `tests/harness/fakeMongo.ts` + `fakeTelegram.ts`. |
| Real integration tests | **None.** No test connects to a real MongoDB, Telegram, Wallet or Vercel (`grep MONGODB_URI/mongodb-memory` finds none usable). |
| Load tests | **None.** |
| Unverified production behaviour | real transaction isolation / `WriteConflict` retries, TTL sweep timing, query planner/index use, `waitUntil` semantics on the actual Vercel plan, cold-start cost and pool exhaustion, Telegram rate limits (429) under concurrency, Wallet API cursor semantics, the "third user" symptom. |

Fake-harness limitations (header of `fakeMongo.ts`): writes inside a transaction are visible immediately (read-uncommitted); no `WriteConflict`/`TransientTransactionError`; rollback only for writes made with `{session}`; no TTL expiry; no planner. Therefore passing tests prove business logic and idempotency shape, **not** concurrency safety.

---

## 9. Deployment continuity & VPS portability

**Depends on process memory / timers / function lifetime**
- Anonymous-search countdown (`search.ts`, `waitUntil`) — cosmetic number + opportunistic rescan + timeout; match/cancel/timeout truth is in Mongo (`match_queue`, `search_notices`). A deploy mid-countdown loses only the live display and the 3-s-before-end rescan; other searchers still match against the queue; timeout notice recovers via `searchNotices` (opportunistic, daily cron at worst).
- Seed default-member script (`seedMatch.ts runSeedScript`, up to 55 s) — durable `seed_jobs` + `settleDueSeedChat`.
- User export/import in `waitUntil` (F-16).
- Per-instance module caches (`emojis`, `appVars`, `joinedCache`, `lastRun`/`lastAuto` gaps for the opportunistic jobs, `indexed` flags, `globalThis.__navaMongo`): safe to lose; they cause only extra DB work after a restart.
- Opportunistic jobs are gated by Mongo-backed leases (safe across instances).

**Durable and recoverable:** update inbox, ledger, Stars orders/exceptions, wallet deposits + cursor, broadcast/jeton jobs (lease+CAS), match deliveries, search notices, admin flow state, rate limits, game documents (no TTL on unsettled games since v1.28).

**Not durable / not proven:** a deploy during a webhook transaction relies on Mongo aborting the open tx and Telegram redelivering (5xx); correctness then rests on idempotent handlers (designed; unproven on real Mongo).

**Vercel-specific code:** `@vercel/functions waitUntil` (`search.ts`, `userBackup.ts`, `shop.ts`, `api/webhook.ts`, `api/miniapp.ts`), `@vercel/node` request types in `api/*`, `vercel.json` (functions, crons, headers), `/api/*` file layout. Business logic in `src/` is host-agnostic except those `waitUntil` imports.

**VPS portability (assessment, no change proposed):** feasible without rewriting business logic. Needed: (1) a thin HTTP server (Express/Fastify) mapping the six `api/*` handlers; (2) replace `waitUntil` with a long-lived process task (a tiny `background.run(promise)` shim imported in the 4 places); (3) replace Vercel crons with a scheduler hitting the same endpoints or in-process timers with the existing Mongo leases; (4) on a long-lived process, raise the Mongo pool, make `withTransaction` time-bounded, and move the per-request opportunistic jobs to an interval; (5) static `public/` via nginx. Risk to watch: the in-process countdown becomes reliable but must still be restart-safe (it already is by design).

---

## 10. Scale limitations & required load tests

No claim of 1M-user readiness is supportable. Before any such claim, run (on a staging replica set + staging bot):
1. 100–500 concurrent webhook updates with the real pool size (find pool exhaustion).
2. Concurrent searches incl. simultaneous opposite-gender pairs and a third-user probe; measure transaction retries and p99 latency.
3. Mini App `pulse` with N concurrent clients × poll interval.
4. User search on 1M synthetic `users` documents (explain plans; regex and skip pagination).
5. Broadcast / jeton-mass run of 100k+ recipients against Telegram's real rate limits.
6. Export of 1M users within function limits.
7. Index audit with `explain()` for each hot query listed in F-12.
8. Wallet sync under a backlog of thousands of transfers.

---

## 11. Outdated documentation, branding, unused components

**Version:** runtime strings consistent at 1.29.1. `README_FA.md:1,207,213` and `README_EN.md:1,175` still say **1.11.0**; `README_FA.md:197` shows a `v1.13.0` example. `README_EN.md:87` claims the cron runs "every 2 minutes" while `vercel.json` has two **daily** crons. `docs/AUDIT_*.md` are historical (correct as history). The CHANGELOG header note says the version must also live in the zip name — followed.

**Branding — classified separately (nothing renamed):**
- *User-facing outdated:* README_FA/EN titles ("Nava Bot", "نوا‌گرام"); a mixed-name line `README_FA.md:8`; `public/monitor/index.html` has two inconsistent labels (one is a code comment). The Persian locale `fa.ts` has no "رلیک" and uses "ژتون" consistently; the welcome text uses "مویا".
- *Internal identifiers (do NOT rename without an approved migration):* DB name default `nava` (`env.ts MONGODB_DB_NAME`), `services/nava/`, `NavaContext`, `NAVA_MINIAPP_URL`, `navagramAdmin.ts`, field `relicBalance`, ledger type names, `sourceApp: "nava"`, the monitor's "Nava ID" label for the anonymous id.
- *Docs/comments only:* large parts of `docs/`, comments in `core.js`.
- Existing tooling: `scripts/migrate-brand.ts` + `services/brandMigration.ts` (dry-run default, backup required for `--apply`, rollback) — reuse, do not hand-replace.

**Potentially unused / misleading:** `src/features/wallet/` (empty directory); `src/features/search/userSearch.ts` is **in use** (`bot.ts:17`) — the folder name only is misleading; `services/brandMigration.ts` is script-only (not dead); `tools/` are build-time generators; `gift-packs/starter-pack.zip` has no runtime reference (probable artifact); `scripts/bg-reconcile.ts` is an operational tool.

---

## 12. Prioritised remediation roadmap (nothing implemented — awaiting approval)

Order = risk reduction per regression risk. For each: modules touched → regression risk.

1. **F-05 photomod permission rows** — `permGate.ts` (+ a completeness test). Risk: very low.
2. **F-02 anon-message age/block check** — `features/anonMessages`. Risk: low.
3. **Decision needed from the owner for F-01** (hide vs read-only across bands, handling of existing cross-band follows), then implement the shared band helper across `services/nava/*` + `api/miniapp.ts` + media GET. Risk: high (whole social UI) → ship behind a settings switch, add tests first.
4. **F-03/F-15 error-code & log-channel system** — new `services/errorReport.ts`, hooks in `bot.ts`, `api/webhook.ts`, `api/miniapp.ts`, `channelRouting.ts` purpose. Risk: low (fire-and-forget).
5. **F-04 game wallet hardening** — `services/games/wallet.ts` (+ extend `v128-game-stakes-off`). Risk: medium for legacy staked settlement.
6. **F-07 wallet receipt/unmatched handling** — `walletDeposits.ts` (+ owner action). Risk: low-medium (notification duplicates).
7. **F-06 media URL signing/caching** — `services/nava/media.ts`, `api/miniapp.ts`, `public/miniapp/sw.js`. Risk: medium.
8. **F-08/F-09 relay re-check + game lobby band** — `features/matching/*relay*`, `services/games/*`. Risk: medium.
9. **F-10 read-only ledger/balance reconcile script** — new script only. Risk: none to runtime.
10. **F-11/F-12/F-13 real-infrastructure work:** staging replica set, bounded `withTransaction`, indexes, load tests (§10), cron plan (external pinger or paid plan; alert when `CRON_SECRET` missing). Needs real evidence before code changes.
11. **F-14 limiter fallback, F-16 export/import checkpoints, F-17 staff audit log, F-18/F-19 hardening, docs/README refresh (§11).**

A cumulative history entry should be added on approval as `docs/AUDIT_v1.29.1.md`, carrying the v1.28.0 table forward with these statuses:

| v1.28.0 # | Item | Status at v1.29.1 |
|---|---|---|
| 1 | Age separation for contact paths | Contact/discovery **verified enforced**; social layer **still open** (F-01, F-02, F-08, F-09) |
| 2 | Stars order replay | **Verified fixed** (READ) |
| 3 | Banned payer's payment | **Verified**: payments composer precedes ban middleware (`bot.ts:190-217`) |
| 4 | Granular admin permissions | **Mostly fixed; one bypass found** (F-05) |
| 5 | Staked backgammon off / TTL index | **Verified in code**; contract weakness (F-04) |
| 6 | Broadcast lease/CAS | Tests exist; **not re-read** in this audit |
| 7 | Bot token to third party | Fix reported; **not re-read** |
| 8 | Moderation threshold | **Not re-read** |
| 9 | Wallet notify after success | **Partially fixed**: user notice OK, log receipt gap (F-07) |
| 10 | Legacy brand strings | Partially: runtime fixed, README/docs stale (§11) |

**Stop point:** no implementation, refactor, rename or database change was made. Waiting for the project owner's approval (and the product decisions flagged in F-01, F-17 and F-04) before any work begins.


---

## 4. Earlier audit documents (kept unchanged in this folder)

- `docs/AUDIT_v1.16.1.md`
- `docs/AUDIT_v1.16.3.md`
- `docs/AUDIT_v1.17.0.md`
- `docs/AUDIT_v1.27.1.md`
- `docs/AUDIT_v1.28.0.md`
