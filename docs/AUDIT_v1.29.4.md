# MOYA / MoyaGram — Cumulative Audit History (as of v1.29.4)

Sections 3–6 are verbatim: prompts are copied from the original attachment files or the session transcript, assistant reports from the session transcript, and the older audit text from `docs/AUDIT_v1.29.3.md` (kept unchanged next to this file). Only sections 1 and 2 are new in this version. Nothing was reconstructed.

## 1. Resolution tracker (status history preserved)

| ID | Finding | Status history |
|---|---|---|
| F-01 | Social surface has no age-band check | OPEN |
| F-02 | Anonymous message links ignore age band and blocks | v1.29.1 audit: CONFIRMED → v1.29.2: reported FIXED → independent audit found 3 gaps → v1.29.3: completed (mock-tested; race window reduced, not eliminated) → v1.29.4: further gaps tracked as F-22…F-25 (below) |
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
| F-17 | Staff/official accounts bypass age separation | OPEN — unresolved owner decision (policy unchanged in v1.29.2, v1.29.3 and v1.29.4) |
| F-18 | Stars minor hardening | OPEN |
| F-19 | Game registry isolation gaps | OPEN |
| F-20 | Public /api/health | OPEN (note only) |
| F-21 | Seed script vs 60 s limit | OPEN (unverified) |
| F-22 | Sender Telegram id exposed in anonymous-message callback_data (introduced by the v1.29.3 deterministic record id) | reported by independent audit of v1.29.3 → **FIXED in v1.29.4** for new messages (mock-tested); buttons of messages already sent with v1.29.3 are not retroactively changed |
| F-23 | Pending anonymous link not resumed after Mini App onboarding | **FIXED in v1.29.4** (mock-tested) |
| F-24 | Pending link deleted before the continuation finished (not recoverable) | **FIXED in v1.29.4** (lease; mock-tested; no real-MongoDB concurrency test) |
| F-25 | mayWriteNow did not check the sender's ban status | **FIXED in v1.29.4** (mock-tested) |

## 2. v1.29.4 change record (Task 4: F-22, F-23, F-24, F-25 only)

### 2.1 Files
Changed (compared with the delivered v1.29.3 archive; nothing deleted):
- `src/db/models/anonMessages.ts` — `cbId` field; `getAnonMessageByButtonId`; lease API (`claimPendingTarget`, `completePending`, `releasePending`, `clearPending`); `setPendingTarget` resets lease/attempts; lazy `cbId` index
- `src/features/anonMessages/index.ts` — opaque button ids, ownership check on every callback, `mayWriteNow` sender-ban check, lease-based `beginCompose` / `resumePendingAnon`, `resumePendingAnonForUser`, recovery on plain `/start`
- `src/services/miniOnboarding.ts` — calls `resumePendingAnonForUser` after the guarded completion (F-23)
- `tests/regression/v1292-anon-photomod.test.ts`, `tests/regression/v1293-anon-complete.test.ts` — only the callback strings: the buttons now carry `cbId` instead of `_id` (same assertions)
- `CHANGELOG.md`, version strings 1.29.3 → 1.29.4 in `src/config/version.ts`, `package.json`, `public/miniapp/sw.js`, `public/miniapp/core.js`, `public/miniapp/index.html`
Added: `tests/regression/v1294-anon-privacy-pending.test.ts` (26 tests), `docs/AUDIT_v1.29.4.md`.
Not modified: `package-lock.json`, deployment configuration, game/wallet/Jeton/payments code, `bot.ts`, `blocks.ts`, `user.ts`, admin and every other module.

### 2.2 F-22 — opaque callback ids
Cause: v1.29.3 made the record `_id` deterministic (`<fromId>:<telegram message id>`) for duplicate protection and the same `_id` was put into `anon:reply:` / `anon:read:` callback data, so the recipient's client could read the sender's Telegram id.
Fix: every new record gets a random 12-byte `cbId` (16 URL-safe characters). Buttons carry only `cbId`. `_id` stays the internal duplicate-protection key, so idempotency does not depend on the public handle. The callbacks resolve the record with `getAnonMessageByButtonId`: handle format is validated (`^[A-Za-z0-9_:-]{1,40}$`), the record is looked up by `cbId`, and only records WITHOUT a `cbId` (written before 1.29.4) are also reachable by `_id` — so buttons already in chats keep working, while a new record can not be probed through its internal key (no "is the sender X?" oracle). Ownership (`doc.toId === ctx.from.id`) is checked on every press; unknown, malformed, forged and foreign ids get the same answer and change nothing. The reply flow stores the internal `_id` (never shown).

### 2.3 F-24 — recoverable pending link
Before: `takePendingTarget` deleted the record first; a failure afterwards lost the link.
Now: `claimPendingTarget` (single `findOneAndUpdate`) takes a 60 s lease with a random token and counts the attempt; it returns nothing while an unexpired lease exists, after 3 attempts, or after 24 h (an expired record is also deleted). The link is removed with `completePending(token)` only after the compose flow exists (or after a final refusal: age band / block / ban / target gone); the force-join screen hands it back with `releasePending` (attempts reset, not a failure). The compose prompt is sent after completion, so a retry after a crash can never produce a second prompt; the flow is an idempotent upsert, so it can never produce a second flow. A crashed worker's lease simply runs out; the next trigger (onboarding completion, force-join «عضو شدم», Mini App signup, or the user's next plain `/start`, which runs after the normal /start handling because that handler resets all flows) claims it again. Direct opening of a link by a finished user is unchanged (stored, then removed without a lease). No distributed-lock system was added.

### 2.4 F-23 — Mini App signup
`onboardSave` (single guarded update, so only one call can complete the account) now calls `resumePendingAnonForUser(api, userId)`, which builds a minimal private-chat Context around the bot API and runs the SAME `resumePendingAnon` (fresh onboarding check, lease, `mayWriteNow` age band + blocks + bans, force-join check). It never throws.

### 2.5 F-25
`mayWriteNow` now refuses when the SENDER or the recipient is banned, reading both from the database at call time (no `ctx.dbUser`).

### 2.6 Schema / index / migration
New optional field `anon_messages.cbId`; new optional pending fields `claimUntil`, `claimToken`, `attempts`; new sparse non-unique index `cbId_1` on `anon_messages`, created lazily and idempotently on the first message creation after a cold start (without it lookups still work, only slower). No migration, no backfill, nothing renamed or deleted; old records and buttons keep working.

### 2.7 Evidence (executed in this session, fake Mongo / fake Telegram harness only)
- `npx tsx --test tests/regression/v1294-anon-privacy-pending.test.ts` → 26 tests, 26 pass. Against the unfixed v1.29.3 tree: 5 pass / 21 fail.
- `npm test` → 509 tests, 509 pass, 0 fail (483 + 26).
- `npx tsc --noEmit` → exit 0; `npm run build` → exit 0 (output removed afterwards).
- `npm ci` in a clean copy (no node_modules) → exit 0; `package-lock.json` unchanged; there `tsc --noEmit` exit 0 and the 66 anon tests (v1.29.2 + v1.29.3 + v1.29.4 files) pass. `npm ci` printed `npm audit` warnings; nothing changed because of them.
- NOT executed: any real MongoDB (replica set) test, real Telegram, Vercel, load or real concurrency test; the fake database has no real isolation, so the "concurrent claim" tests show the application logic of one `findOneAndUpdate` claim, not MongoDB's behaviour.

### 2.8 Remaining risks
- Messages already delivered by v1.29.3 keep buttons that contain the old `<fromId>:<msgId>` id (Telegram clients still show it to the recipient). Fixing them needs editing every such message — not done. Those records also stay reachable through `_id`.
- A worker that was claimed-over (lease expired while it was still running) can still write its flow late; the new link's token is not checked when the flow is written (narrow, last-writer-wins on one flow document).
- Crash between `completePending` and the prompt leaves a flow without a prompt (chosen over a possible duplicate prompt).
- Recovery needs a trigger (no background sweeper): next onboarding/force-join/Mini App signup/plain `/start`; otherwise the link expires after 24 h.
- The Mini App path runs the continuation inside the HTTP request of `onboard_save`; the minimal Context was only exercised with the fake Telegram API.
- Mongo behaviour of the claim filter (`$and`/`$or`/`$exists`/`$lte`/`$inc` in one `findOneAndUpdate`) is standard but untested on real MongoDB.
- Pre-existing, unchanged: TOCTOU limits from v1.29.3 section 2.2 (snapshot isolation cannot see a concurrent block/age edit; Telegram send after commit), F-17 staff/official exemption (unresolved owner decision), F-01 and all other open findings.

---

## 3. Prompt history, verbatim

### 3.1 Request A (v1.29.0 work, Persian)

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

### 3.2 Request B (v1.29.1 work, Persian)

````text
رو دکمه
به یه ناشناس وصلم کن

یکم کار کن
تایمر درست کار نمیکنه
وقتی دونفر همزمان میزنن رو دکمه به یه ناشناس وصلم کن و جنسیت رو انتخاب می‌کنند
ربات به باگ میخوره و برا شخص سوم که میخواد بره تو بات دکمه ای رو بزنه کار نمیکنه


از اول بررسی عمیق کن مشکلشو برطرف کن
````

### 3.3 Task 1 — read-only audit brief (attachment `e1784dc4-attachment.txt`)

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

### 3.4 Task 2 — fix F-05 and F-02 only (as sent in the session)

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

### 3.5 Task 3 — complete F-02 (attachment `63c7e873-attachment.txt`)

````text
Task 3 — MoyaGram v1.29.2 → v1.29.3

Complete the Remaining F-02 Anonymous Messaging Security Fixes

Hello Claude,

ChatGPT is acting as the project's senior technical manager and independent security auditor. You are the implementation engineer. The project owner has authorized this narrowly scoped task.

Your job is to complete the remaining F-02 issues identified during the independent audit of v1.29.2.

1. Fix the "anon:read" notification bypass

- Re-check the current age-band eligibility and bilateral block status before notifying the sender that an anonymous message has been read.
- If communication is no longer permitted, update the local read status if appropriate, but do not send a read notification to the other user.
- Ensure the UI response does not falsely claim that a notification was delivered.
- Do not allow stale callback data to bypass current authorization checks.

2. Address the TOCTOU race in anonymous message delivery

- Review the complete flow from the final authorization check through database insertion and Telegram delivery.
- Minimize the authorization-to-write race window.
- Use an atomic or transaction-based approach where supported by the existing architecture.
- If a fully atomic solution is impossible because of external Telegram API boundaries, explicitly document the remaining limitation.
- Never claim that checking immediately before insertion completely eliminates the race.
- Preserve idempotency and prevent duplicate messages or records during retries.
- Do not introduce a new database architecture or unrelated schema migration without explicit approval.

3. Fix pending anonymous-link resumption after onboarding

- Investigate the stale "ctx.dbUser" issue after "setNicknameOnce()" completes onboarding.
- Ensure the updated user state is available before "resumePendingAnon(ctx)" checks onboarding status.
- Alternatively, safely retrieve the current user state from the database.
- Add a regression test that executes the actual onboarding completion path, not merely a manually prepared Context.
- Verify that pending anonymous links resume exactly once and cannot bypass current age/block checks.

4. Add missing regression tests

Add focused tests for:

- Read notification after a bilateral block.
- Read notification after an age-band change.
- Authorization changes between the final check and database insertion.
- Concurrent delivery attempts and duplicate prevention.
- Actual onboarding completion followed by pending-link resumption.
- Permission and eligibility checks after stale callback interactions.

Tests must assert actual observable outcomes, including database writes and Telegram delivery attempts. Avoid tautological assertions that are always true.

5. Strict scope and regression requirements

- Only modify files directly required for F-02.
- Do not modify F-01, F-03 through F-21, or unrelated modules.
- Do not change game logic, wallet, Jeton, Stars payments, backgammon, chat, profiles, social features, or admin functionality except where strictly necessary for the authorized F-02 fix.
- Do not enable wagering or introduce betting functionality.
- Do not perform global string replacements.
- Preserve existing user data, settings, database compatibility, and current Persian UI text unless a change is strictly necessary.
- Maintain backward compatibility.
- Do not silently change staff/official account exemptions. Keep the existing policy and report it as an unresolved owner decision under F-17.

6. Verification requirements

Run and report:

1. Focused regression tests.
2. Full "npm test".
3. "npx tsc --noEmit".
4. "npm run build".
5. "npm ci" in a clean environment, if feasible.
6. A diff review confirming no unrelated files or behaviors changed.

Clearly distinguish:

- Tests actually executed and passed.
- Tests not executed.
- Mock-based tests.
- Real MongoDB/Telegram integration tests.
- Remaining race conditions and architectural limitations.

Do not claim real integration or production-scale verification based on mocks.

7. Version and delivery

- Target version: v1.29.3.
- Update version references consistently in the files that legitimately require version updates.
- Do not make unrelated package or dependency changes.
- Do not modify "package-lock.json" merely to make its version string look consistent. If a legitimate lockfile correction is required, explain why and show the exact diff first.

Deliver:

1. Complete updated project ZIP.
2. Exact list of changed, added, and deleted files.
3. Per-fix technical explanation.
4. Test results with actual commands and outputs.
5. Remaining risks and unresolved items.
6. Updated cumulative audit tracker, preserving all previous findings and their original status history.
7. The exact prompt history and implementation reports. Do not reconstruct or paraphrase previous prompts while presenting them as verbatim originals.

Important: Do not start F-01 or any other open audit finding. This task is exclusively for completing F-02.

If any requirement cannot be implemented safely within this scope, stop and explain the blocker instead of introducing an unapproved workaround.
````

### 3.6 Task 4 — F-22…F-25 (attachment `3a09a1ee-attachment.txt`)

````text
MoyaGram v1.29.4 — Targeted Privacy, Pending-Link Recovery & Authorization Fixes

Hello Claude,

I am the implementation engineer for this project. ChatGPT is acting as my senior technical manager and independent security auditor. The project owner makes all final architectural and product decisions.

Please inspect the current v1.29.3 source code and implement the following four findings identified during the independent audit.

F-22 — Prevent Telegram User ID Exposure in Anonymous Message Callbacks (HIGH PRIORITY)

Current issue:
Anonymous message record IDs use a predictable format containing the sender's Telegram ID and message ID. The record ID is included in Telegram inline keyboard "callback_data", potentially exposing the sender's Telegram ID to the recipient.

Requirements:

1. Never expose sender Telegram IDs, recipient Telegram IDs, or other identifying information in callback data.
2. Introduce an opaque, non-reversible callback identifier.
3. Preserve deterministic idempotency and duplicate-message protection independently of the public callback identifier.
4. Ensure reply/read callbacks resolve records securely on the server.
5. Validate authorization and ownership on every callback. A recipient must never access another user's anonymous message by manipulating callback data.
6. Preserve compatibility with existing anonymous message records and buttons where safely possible. Do not perform destructive migrations or invalidate existing records without an explicit migration plan.
7. Add regression tests proving that callback data does not reveal Telegram IDs and that forged or unauthorized callbacks are rejected.

F-23 — Resume Pending Anonymous Links After Mini App Signup

Current issue:
When a user completes onboarding through the Mini App, a pending anonymous-message link is not resumed. The bot signup and forced-join paths already handle this flow.

Requirements:

1. Integrate pending-link continuation into the successful Mini App onboarding completion path.
2. Reuse the existing validation and authorization logic rather than duplicating it.
3. Ensure continuation happens only after successful onboarding.
4. Preserve age-band and block restrictions.
5. Prevent duplicate continuation if multiple completion events arrive.
6. Do not send duplicate messages or create duplicate flows.
7. Add regression tests for successful Mini App onboarding, duplicate events, blocked users, and expired pending links.

F-24 — Make Pending-Link Consumption Recoverable

Current issue:
"takePendingTarget" deletes the pending record before the subsequent operations finish. A temporary database or processing failure can permanently lose the pending link.

Requirements:

1. Replace immediate destructive consumption with a safe claim/lease or equivalent recoverable mechanism.
2. Ensure concurrent workers cannot process the same pending link simultaneously.
3. Allow recovery after a worker crash or temporary failure.
4. Use bounded retries and expiration rules.
5. Mark the pending link as completed only after the continuation has safely reached its intended state.
6. Ensure retrying cannot create duplicate flows or duplicate anonymous messages.
7. Keep the mechanism compatible with the existing database architecture and deployment environment.
8. Add tests for concurrent claims, worker failure, lease expiration, retry, successful completion, and expired links.

Do not introduce an unnecessarily complex distributed locking system.

F-25 — Check Sender Ban Status in Final Authorization

Current issue:
"mayWriteNow()" checks "to.banned" but does not check "from.banned".

Requirements:

1. Check the fresh database state of both sender and recipient.
2. Reject the operation if either account is banned.
3. Preserve existing age-band and bidirectional block checks.
4. Do not rely exclusively on cached "ctx.dbUser" data for this final authorization.
5. Add regression tests for a sender banned after the initial middleware check and a recipient banned before the final authorization check.

Strict Engineering Constraints

1. Do not modify unrelated modules or refactor unrelated code.
2. Preserve existing user data, settings, anonymous-message history, and active application behavior.
3. Do not use global string replacements.
4. Do not weaken age separation, block checks, admin permissions, or privacy protections.
5. Do not change the F-17 staff/official exemption policy. Report it as an unresolved owner decision.
6. Do not enable wagering or modify the Jeton/game wallet system.
7. Preserve backward compatibility wherever safely possible.
8. All changes must be modular and regression-free.
9. Do not claim real MongoDB, Telegram, Vercel, or production concurrency validation unless those tests were actually performed.
10. Do not modify production credentials or deployment settings.

Required Verification

After implementation:

- Run the focused regression tests for all four findings.
- Run the complete test suite.
- Run TypeScript checks.
- Run the production build.
- Verify "npm ci" in a clean environment if possible.
- Check for unintended changes outside the intended files.
- Verify callback data contains no Telegram identifiers.
- Verify pending-link recovery and idempotency under simulated concurrency.
- Clearly distinguish mock-based tests from real integration tests.

If a test fails, report the exact failure. Do not hide, skip, or relabel failed tests as passed.

Required Final Report

Provide a complete report containing:

1. Exact files changed and why.
2. Explanation of each F-22, F-23, F-24, and F-25 implementation.
3. Database schema/index changes, if any.
4. Migration and backward-compatibility implications.
5. Exact test commands and results.
6. Tests not performed and why.
7. Remaining risks and unresolved issues.
8. Confirmation that unrelated modules were not changed.
9. Updated version and changelog details.
10. The complete implementation history, including previous prompts and responses, preserving the original wording wherever available. Do not reconstruct missing history and present it as an original record.

Do not start any additional feature or address F-01 as part of this task.

The objective is a narrowly scoped, secure, recoverable, regression-free implementation—not merely passing mocked tests.
````

---

## 4. Reports given to the owner, verbatim (assistant's final message of each delivery)

### 4.1 v1.29.0 delivery report

````text
همه‌ی خواسته‌ها تو نسخه‌ی **1.29.0** انجام شد و فایل `nava-project-v1.29.0.zip` رو فرستادم. تایپ‌چک تمیزه و ۴۳۵ تست پاس شدن (چند تست قدیمی که رفتار قبلیِ تایید رو چک می‌کردن به قوانین جدید تغییر دادم). روی تلگرام واقعی تست نشده؛ تست‌ها با تلگرام و دیتابیس شبیه‌سازی‌شده اجرا شدن.

**۱. عکس و نام بدون تایید**
- عکس و نام فوری اعمال می‌شن (هم تو ربات هم تو مینی‌اپ).
- یه نسخه برای مالک/کانال مدیریت میاد با **فقط یه دکمه‌ی شیشه‌ای «عدم تأیید»**، بدون دکمه‌ی تایید.
- با زدنش، عکس کاربر پاک می‌شه (فقط اگه هنوز همون عکس باشه) یا نام به نام قبلی برمی‌گرده. برای کاربر هم پیام «به دلیل عدم رعایت قوانین…» می‌ره.
- تغییر **سن** هنوز با تایید مالکه، چون فقط عکس و نام رو گفتی.
- متن پیام بعد از «عدم رعایت» ناقص بود؛ من «قوانین» رو گذاشتم. اگه متن دیگه‌ای می‌خوای بگو.

**۲. 🪙 مدیریت ژتون (مالک)**
- سه دکمه‌ی شیشه‌ای باز می‌شه: **کم‌فعالیت‌ها** (تعداد روز)، **جنسیت** (دختر/پسر)، **کاربر یا کاربران مشخص** (آیدی عددی).
- هر کدوم می‌پرسه تعداد ژتون، بعد پیام، بعد «پیام دوم هم بفرستم؟»، بعد خلاصه و تایید.
- به کاربر فقط همون پیام(های) خودت می‌ره. پیام «شارژ شدید» نمی‌ره.
- تو کانال لاگ برای کل ارسال فقط یه پیام خلاصه میاد (تعداد نفر، ژتون هر نفر، مجموع).
- ژتون هر نفر دقیقاً یه بار ثبت می‌شه، حتی اگه ارسال وسط کار قطع بشه. اگه تعداد زیاد بود، دکمه‌ی «▶️ ادامه‌ی ارسال» میاد و کران روزانه هم ادامه می‌ده.
- من یه دکمه‌ی چهارم هم اضافه کردم، «تعدیل دستی یک کاربر»، تا کسر ژتون قبلی از دست نره. ادمین‌های غیرمالک همون روند قبلی رو دارن.
- استفاده از مینی‌اپ هم «فعالیت» حساب می‌شه، وگرنه کسی که فقط مینی‌اپ می‌زد کم‌فعال به نظر می‌رسید.

**۳. باگ بج:** پالسِ مینی‌اپ بج و تیک کاربر رو اصلاً نمی‌خوند، برای همین خودِ کاربر تا بستن و باز کردن برنامه بجش رو نمی‌دید. درست شد. بج تو کارت‌های مچ هم نشون داده می‌شه. سقف انتخاب بج تو مینی‌اپ ۶ بود ولی سرور ۸ می‌گرفت؛ هر دو ۸ شدن.

**۴. عکس پروفایل**
- عکس دکمه‌ی پروفایل همون عکس صفحه‌ی مینی‌اپه؛ یه عکس ذخیره می‌شه و دوباره درخواست نمی‌شه.
- کسی که فقط عکس پیش‌فرض داره، تو پروفایل ربات و بعد از ثبت‌نام دکمه‌ی «📸 ثبت عکس پروفایل» می‌بینه. این دکمه‌ست، اجباری نیست؛ اگه می‌خوای قبل از ادامه‌ی کار اجباری بشه بگو.
- پست عکس پروفایل حذف نمی‌شه، از منوی ⋮ می‌شه کپشنش رو گذاشت یا عوض کرد. بقیه‌ی پست‌ها قابل حذفن. وقتی عکس عوض بشه، کپشن قبلی پاک می‌شه.

ورژن تو ۷ جای لازم بالا رفته و CHANGELOG هم نوشته شده.
````

### 4.2 v1.29.1 delivery report

````text
نسخه ۱.۲۹.۱ آماده است و چند باگ واقعی تایمر و پیام جستجو را درست کرده، ولی علت اصلی «دکمه برای نفر سوم کار نمی‌کند» را پیدا نکردم. تست‌ها هم روی MongoDB شبیه‌سازی‌شده اجرا شده‌اند، نه روی MongoDB واقعی و Vercel؛ تراکنش‌های همزمان واقعی آن‌جا تست نشده‌اند.

**چیزهایی که پیدا و درست شد:**
- **تایمر می‌پرید:** عدد بعد از هر تیک با تأخیر شبکه جابه‌جا می‌شد (۲، ۵، ۷، ۱۰). حالا ثابت ۲، ۴، ۶، … نشان داده می‌شود.
- **شروع ۴۰ ثانیه:** از لحظه‌ی فشردن دکمه حساب می‌شود، نه از لحظه‌ی شروع شمارش. قبلاً گاهی TTL مونگو ردیف صف را چند ثانیه قبل از پایان پاک می‌کرد. نتیجه‌اش این بود که تایمر روی ۳۸ می‌ماند و پیام «کسی پیدا نشد» نمی‌آمد.
- **پیام «در حال جستجو» یخ‌زده:** اگر طرف مقابل کاربر را وصل می‌کرد یا کاربر دوبار پشت‌سرهم می‌زد، پیام قدیمی با تایمر و دکمه‌ی لغوِ مرده می‌ماند. حالا هر جستجو پیام وضعیت خودش را در همه‌ی حالت‌های پایانی پاک می‌کند.
- **حذف پیام وضعیت:** اگر کاربر پیام وضعیت را پاک می‌کرد، کل جستجو بی‌صدا متوقف می‌شد. حالا فقط عدد ادیت نمی‌شود و جستجو ادامه دارد.

**چیزی که پیدا نکردم:** با موتور جستجو و وبهوک را خط‌به‌خط خواندم و همین سناریو را روی شبیه‌ساز زدم. دو نفر با جنسیت مخالف همزمان و یک نفر سوم که دکمه می‌زند، درست کار کرد؛ فقط همین‌ها را ۵ بار پشت‌سرهم تکرار کردم. اگر بعد از این نسخه هنوز اتفاق افتاد، لاگ‌های Vercel همان لحظه (خطوطی که با `[nava:webhook]` و `[search]` شروع می‌شوند) و ساعت دقیقش را بفرست.

هشت تست جدید در `v1291-search.test.ts` اضافه شد و کل ۴۴۳ تست پاس است. نسخه و changelog به‌روز شد.

فایل: `/home/claude/out/nava-project-v1.29.1.zip`
````

### 4.3 Task 1 audit summary message

````text
گزارش کامل ممیزی نسخه ۱.۲۹.۱ آماده است: `MOYA_AUDIT_v1.29.1.md`. این فقط خواندن بود و هیچ فایل پروژه تغییر نکرده. بررسی کردم که بعد از تحویل zip هیچ فایلی عوض نشده است. به تلگرام، مونگو، ولت یا ورسل واقعی هم وصل نشدم.

**محدودیت‌های ممیزی:**
- تست‌ها را در این ممیزی دوباره اجرا نکردم. آخرین اجرا، همان ۴۴۳ تست سبز موقع تحویل ۱.۲۹.۱، همه روی شبیه‌ساز مونگو بود. تست واقعی روی مونگو و تست بار هیچ‌کدام وجود ندارد.
- دو بخش از بررسی (ژتون/بازی/پرداخت و ادمین/امنیت) را خودم مستقیم از روی کد خواندم، چون زیرعامل‌ها به محدودیت استفاده خوردند. بخش‌هایی که فقط از گزارش زیرعامل آمده یا دوباره خوانده نشده در گزارش علامت دارند.
- نخواندم: `broadcastProcessor`، جزئیات `jetonMass`، اعتبارسنجی آپلود، کد سمت کلاینت Mini App.

**یافته‌های مهم** (مورد بحرانیِ اثبات‌شده نداشتیم):
- **سن در لایه اجتماعی:** پروفایل، فید، پست، استوری، کامنت، پاسخ استوری، فالو و عکس هیچ چک بازه‌ی سنی ندارند (F-01). لینک پیام ناشناس هم سن و بلاک را چک نمی‌کند (F-02). مسیرهای تماس و کشف (مچ، درخواست چت، DM، هدیه، جستجو) درست اعمال می‌شوند.
- **سیستم کد خطا وجود ندارد (F-03):** نه کد یکتا، نه گزارش در کانال لاگ، نه پیام فارسی همراه کد. بعضی لاگ‌ها هم خطای خام را چاپ می‌کنند.
- **کیف‌پول بازی (F-04):** سوئیچ «غیرفعال» فقط در `hold` چک می‌شود. `pay`، `refund` و `settleWinner` چک نمی‌کنند و `settleWinner` مبلغ دلخواه را بدون تطبیق با holdها واریز می‌کند. مسیر قابل‌سوءاستفاده‌ای در کد فعلی پیدا نکردم؛ این ضعف قرارداد است برای بازی‌های بعدی.
- **دور زدن دسترسی ادمین (F-05):** دکمه‌های `photomod:ban` و `photomod:delete` فقط `isAdmin` را چک می‌کنند و در جدول دسترسی نیستند.
- **لینک عکس (F-06):** لینک‌های امضاشده‌ی عکس هیچ‌وقت منقضی نمی‌شوند و تا یک سال در کش CDN می‌مانند؛ عکسی که با «عدم تأیید» حذف شده هم می‌تواند همچنان نمایش داده شود.
- **رسید ولت (F-07):** رسید کانال لاگ قبل از ارسال علامت می‌خورد، پس با قطع ناگهانی گم می‌شود. واریزهای بی‌کاربر هم ابزار پیگیری ندارند.

بقیه (چک سن هنگام تغییر سن وسط چت، لابی تخته‌نرد، تطبیق دفتر کل با موجودی، تراکنش‌های واقعی، مقیاس، کران‌های روزانه، README قدیمی) و نقشه وابستگی، وضعیت تست‌ها، امکان‌سنجی VPS و نقشه راه اولویت‌بندی‌شده در گزارش هستند.

باگ «دکمه برای نفر سوم کار نمی‌کند» هنوز بازتولید نشده. برای این مورد لاگ‌های ورسل همان لحظه لازم است.

**سه تصمیم از شما لازم است:**
- در F-01: محتوای بین بازه‌های سنی کامل پنهان شود یا فقط خواندنی بماند؟
- در F-17: ادمین‌ها از جداسازی سنی مستثنا بمانند؟
- در F-04: تقویت قرارداد کیف‌پول بازی با تست‌های بازی‌های قدیمی تخته‌نرد هماهنگ شود؟

قبل از تأیید شما هیچ پیاده‌سازی‌ای شروع نمی‌کنم.

فایل: `/tmp/claude-0/-home-claude/e4e2ec71-c530-5a84-b027-1260e9d1c484/scratchpad/MOYA_AUDIT_v1.29.1.md`
````

### 4.4 v1.29.2 (Task 2) delivery report

````text
نسخه‌ی v1.29.2 آماده است (`nava-project-v1.29.2.zip`، بدون `node_modules`) و فقط F-05 و F-02 در آن اصلاح شده‌اند. همه‌ی تست‌ها روی Mongo و Telegram ساختگی اجرا شده‌اند. هیچ تست یا بررسی‌ای روی MongoDB، Telegram یا Vercel واقعی انجام نشده است.

## ۱. فایل‌های تغییرکرده
مقایسه‌ی zip نسخه‌ی ۱.۲۹.۱ با ۱.۲۹.۲ فقط همین‌ها را نشان می‌دهد:
- `src/features/admin/permGate.ts`
- `src/features/photo/chatPhotoModeration.ts`
- `src/features/anonMessages/index.ts`
- `tests/regression/v1292-anon-photomod.test.ts` (جدید)
- `docs/AUDIT_v1.29.2.md` (جدید)
- `CHANGELOG.md`
- شماره‌ی نسخه در `src/config/version.ts`، `package.json`، `public/miniapp/sw.js`، `public/miniapp/core.js` و `public/miniapp/index.html`

`package-lock.json` را دست نزدم. از قبل روی ۱.۲۸.۲ بود و در نسخه‌های ۱.۲۹.x هم بالا نرفته بود. فقط همین دو فایل بالا نیامده و شماره‌ی بقیه‌ی فایل‌ها بالا رفت.

## ۲. توضیح فنی
**F-05:**
- `photomod:delete` به مجوز `users` و `photomod:ban` به مجوز `ban` در جدول `permGate.ts` نگاشت شد. قبلاً این دو در جدول نبودند، برای همین گیت مجوز اصلاً اجرا نمی‌شد.
- در `chatPhotoModeration.ts` هر دو handler حالا هم `isAdmin` را می‌خواهند و هم `mayDo(ctx, مجوز)` را.
- لغو مجوز بین دو فشار دکمه فوراً جلوی اجرا را می‌گیرد، چون مجوز در هر فشار دوباره خوانده می‌شود.
- مجوز هیچ اکشن دیگری عوض نشد.

**F-02:**
- تابع جدید `mayWriteNow(from, to)` هر دو کاربر را تازه از دیتابیس می‌خواند. اگر کاربری وجود نداشته باشد، گیرنده بن باشد یا کاربر به خودش بنویسد، رد می‌شود. بعد همان `canContact` سیاست سنی موجود (سن نامعلوم یا نامعتبر رد می‌شود) و همان `isBlockedEitherWay` بلاک دوطرفه را اجرا می‌کند. منطق جدیدی ننوشتم.
- این چک در این نقاط اجرا می‌شود:
  - شروع نوشتن
  - بعد از عضویت اجباری
  - ادامه‌ی لینک معلق بعد از ثبت‌نام یا عضویت
  - دکمه‌ی پاسخ
  - هر پیام متنی
  - دقیقاً قبل از `createAnonMessage`
- در صورت رد، هیچ رکوردی ساخته و هیچ چیزی تحویل داده نمی‌شود. پیام فقط این است: «امکان ارسال پیام ناشناس به این کاربر وجود نداره.» و به سن یا بلاک اشاره‌ای ندارد.

## ۳. نتایج تست (همه اجراشده)
- `npx tsx --test tests/regression/v1292-anon-photomod.test.ts`: ۲۲ از ۲۲ موفق.
- همین تست‌ها روی کد اصلاح‌نشده‌ی ۱.۲۹.۱: ۹ موفق و ۱۳ ناموفق. یعنی تست‌ها واقعاً باگ‌ها را تشخیص می‌دهند.
- `npm test`: ۴۶۵ تست، ۴۶۵ موفق، ۰ ناموفق (۴۴۳ قبلی به‌علاوه‌ی ۲۲ جدید).
- `npx tsc --noEmit`: بدون خطا.
- `npm run build`: بدون خطا. پوشه‌ی `dist` را بعد از build پاک کردم تا در آرشیو نیاید.

تست‌ها هر مورد خواسته‌شده را پوشش می‌دهند: ادمین با و بدون مجوز، غیرادمین، هم‌بازه‌ی سنی، بازه‌ی متفاوت، سن نامعتبر، بلاک از هر دو طرف، تغییر سن یا بلاک بعد از باز شدن لینک، پاسخ‌ها، ادامه‌ی لینک معلق و نبودن رکورد یا تحویل هنگام رد شدن.

اجرا نشده: هر تست روی MongoDB، Telegram یا Vercel واقعی.

## ۴. ریسک‌های باقی‌مانده
- بین چک نهایی و ساخت رکورد پنجره‌ی بسیار کوچکی هست. دو خواندن جدا از هم‌اند و در یک تراکنش نیستند. این پنجره کم شده، ولی صفر نشده است.
- حساب‌های staff و official در `canContact` معاف‌اند (F-17). این تصمیم مالک است و تغییر ندادم.
- چت ناشناس بازشده هنوز بعد از تغییر سن دوباره چک نمی‌شود (F-08). در این کار نبود.
- بقیه‌ی یافته‌ها (F-01، F-04، F-06، F-07 و بقیه) باز مانده‌اند و هیچ اصلاح دیگری شروع نشد.

## ۵. تاریخچه‌ی تجمیعی
در `docs/AUDIT_v1.29.2.md` است و شامل این بخش‌هاست:
- جدول وضعیت F-01 تا F-21: F-02 و F-05 «اصلاح‌شده در ۱.۲۹.۲»، بقیه «باز».
- متن کامل چهار پرامپت بدون ویرایش: درخواست A، درخواست B، Task 1 و Task 2.
- گزارش کامل ممیزی ۱.۲۹.۱ بدون تغییر.
- اشاره به سندهای ممیزی قبلی داخل پوشه‌ی `docs`.

پرامپت Task 1 را از متن همین گفتگو بازنویسی کردم، چون فایل پیوست اصلی (`e1784dc4-attachment.txt`) در دسترس نبود. اگر نسخه‌ی اصلی‌اش را دارید، کافی است با آن مقایسه کنید.
````

### 4.5 v1.29.3 (Task 3) delivery report

````text
نسخه‌ی v1.29.3 آماده است (`nava-project-v1.29.3.zip`) و فقط F-02 را تکمیل کرده. همه‌ی تست‌ها روی Mongo و Telegram ساختگی اجرا شدند. روی MongoDB، Telegram یا Vercel واقعی هیچ چیزی اجرا نشد.

## فایل‌های تغییرکرده
هیچ فایلی حذف نشد. مقایسه با zip نسخه‌ی ۱.۲۹.۲ فقط این‌ها را نشان می‌دهد:
- **تغییر کرده:**
  - `src/features/anonMessages/index.ts`
  - `src/db/models/anonMessages.ts`
  - `src/db/models/blocks.ts`
  - `src/db/models/user.ts`
  - `CHANGELOG.md`
  - شماره‌ی نسخه در `version.ts`، `package.json`، `sw.js`، `core.js` و `index.html`
- **اضافه شده:**
  - `tests/regression/v1293-anon-complete.test.ts`
  - `docs/AUDIT_v1.29.3.md`
- **دست‌نخورده:** `package-lock.json`. نیازی به تغییرش نبود و `npm ci` با همین فایل موفق شد.

در `blocks.ts` و `user.ts` فقط یک پارامتر اختیاری `session` به `isBlockedEitherWay` و `getUser` اضافه شد. بدون آن پارامتر رفتارشان دقیقاً مثل قبل است.

## توضیح هر اصلاح
1. **اعلان «خوندم»:**
   - وضعیت «خوانده‌شده» همیشه ثبت می‌شود.
   - اعلان به فرستنده فقط وقتی می‌رود که با خواندن تازه از دیتابیس هنوز اجازه‌ی ارتباط باشد (همان `canContact` و `isBlockedEitherWay` قبلی). بعد از بلاک یا تغییر بازه‌ی سنی هیچ پیامی به فرستنده نمی‌رود.
   - جواب دکمه فقط وقتی «به فرستنده اطلاع داده شد ✅» می‌گوید که پیام واقعاً رفته باشد. در غیر این صورت می‌گوید «خوانده شد ✅».
2. **پنجره‌ی race:**
   - چک نهایی و ساخت رکورد حالا در یک تراکنش (`runInTransaction`) انجام می‌شوند.
   - شناسه‌ی رکورد از «فرستنده + شماره‌ی پیام تلگرام» ساخته می‌شود. پردازش دوباره یا همزمان همان پیام فقط یک رکورد و یک ارسال می‌سازد.
   - رکوردهای قبلی با شناسه‌ی تصادفی دست‌نخورده‌اند و migration لازم نیست.
3. **ادامه‌ی لینک بعد از ثبت‌نام:**
   - ریشه‌ی باگ: `ctx.dbUser` قبل از پایان ثبت‌نام خوانده می‌شد و هنوز `NICKNAME_PENDING` نشان می‌داد. برای همین لینک کاربر جدید بعد از ثبت‌نام هرگز ادامه پیدا نمی‌کرد.
   - این باگ در نسخه‌ی ۱.۲۹.۲ هم بود. تست‌های آن نسخه context را دستی با وضعیت تمام‌شده می‌ساختند و آن را نمی‌دیدند.
   - حالا وضعیت فعلی از دیتابیس خوانده می‌شود و لینک معلق به‌صورت اتمیک برداشته می‌شود. فقط یک مسیر (پایان ثبت‌نام یا دکمه‌ی عضویت اجباری) آن را ادامه می‌دهد.

## نتایج اجراشده
- **تست‌های focused (`npx tsx --test tests/regression/v1293-anon-complete.test.ts`):** ۱۸ از ۱۸ موفق.
  - روی کد ۱.۲۹.۲ بدون اصلاح: ۵ موفق و ۱۳ ناموفق، که نشان می‌دهد تست‌ها باگ‌ها را می‌گیرند.
  - تست مسیر واقعی ثبت‌نام (زبان، جنسیت، سن، استان، شهر، نام مستعار) روی کد قبلی رد می‌شود.
- **`npm test`:** ۴۸۳ تست، ۴۸۳ موفق، ۰ ناموفق.
- **`npx tsc --noEmit` و `npm run build`:** هر دو بدون خطا.
- **`npm ci` در کپی تمیز بدون `node_modules`:** موفق. در همان کپی `tsc` بدون خطا بود و ۴۰ تست focused (۲۲ + ۱۸) موفق شدند. `npm ci` هشدارهای `npm audit` درباره‌ی وابستگی‌ها چاپ کرد و من بر اساس آن‌ها چیزی را تغییر ندادم.
- **اجرا نشده:** هر تست روی MongoDB، Telegram یا Vercel واقعی، و هر تست بار یا همزمانی روی دیتابیس واقعی.

## ریسک‌های باقی‌مانده
- **race کاملاً بسته نشد، فقط کوچک‌تر شد:**
  - ایزولیشن snapshot در Mongo باعث نمی‌شود بلاک یا تغییر سن همزمان با این تراکنش تداخل کند، چون تراکنش آن documentها را نمی‌نویسد.
  - ارسال تلگرام بعد از commit است و در هیچ تراکنشی نمی‌گنجد.
  - بستن کامل این پنجره به یک document قفل یا نسخه نیاز دارد که تصمیم معماری است و مجوزش را نداشتم.
- **crash بین commit و ارسال:** رکورد می‌ماند و پیام تحویل نمی‌شود. ارسال مجدد همان پیام تلگرام duplicate حساب می‌شود و دوباره نمی‌رود. یعنی تحویل حداکثر یک‌بار است و تحویل دوباره‌ی احتمالی پذیرفته نشد.
- **ثبت‌نام از مینی‌اپ:** `resumePendingAnon` فقط از ثبت‌نام داخل ربات و دکمه‌ی عضویت اجباری صدا زده می‌شود. اگر کاربری ثبت‌نام را در مینی‌اپ تمام کند، لینک معلقش ادامه پیدا نمی‌کند و بعد از ۲۴ ساعت منقضی می‌شود. این را دست نزدم.
- **F-17:** استثنای staff و official در `canContact` را عوض نکردم. هنوز تصمیم مالک است و چک‌های پیام ناشناس این استثنا را به ارث می‌برند.
- F-01، F-08 و بقیه‌ی یافته‌ها باز ماندند.

## تاریخچه و اصلاح یک ادعای قبلی
- در `docs/AUDIT_v1.29.3.md` جدول وضعیت F-02 مراحل را کامل نگه می‌دارد: تأیید در ممیزی، «اصلاح‌شده» در ۱.۲۹.۲، سه خلأ پیداشده در ممیزی مستقل، و تکمیل در ۱.۲۹.۳. در همان فایل اعلام کرده‌ام که گزارش ۱.۲۹.۲ با «FIXED» بودن F-02 بیش‌ازحد قاطع بود.
- پرامپت‌ها طبق خواسته‌ی شما بازسازی نشده‌اند. Task 1 و Task 3 مستقیم از فایل‌های پیوست کپی شده‌اند، بقیه‌ی پرامپت‌ها و گزارش‌های قبلی از متن همین گفتگو.
- در گزارش قبلی گفتم متن Task 1 را بازنویسی کرده‌ام چون پیوست اصلی در دسترس نیست. این درست نبود: پیوست در دسترس بود و متنی که در `AUDIT_v1.29.2.md` گذاشته بودم با آن یکسان است.
````

---

## 5. Complete content of the previous cumulative file `docs/AUDIT_v1.29.3.md` (unchanged; it embeds `AUDIT_v1.29.2.md`, which embeds the full v1.29.1 audit report F-01…F-21)

````````markdown
# MOYA / MoyaGram — Cumulative Audit History (as of v1.29.3)

Sections 3–6 are verbatim: prompts are copied from the original attachment files / the session transcript, reports from the session transcript, and the older audit text from `docs/AUDIT_v1.29.2.md` (kept unchanged next to this file). Only sections 1 and 2 (tracker and this task's change record) are new.

## 1. Resolution tracker (status history preserved)

| ID | Finding | Status history |
|---|---|---|
| F-01 | Social surface has no age-band check | OPEN |
| F-02 | Anonymous message links ignore age band and blocks | v1.29.1 audit: CONFIRMED → v1.29.2: reported FIXED (compose, reply, resume, pre-insert check; mock-tested) → independent audit of v1.29.2 found 3 remaining gaps (`anon:read` notice, check/insert race window, pending link after real onboarding) → **v1.29.3: completed** (mock-tested; race window reduced, NOT eliminated — see section 3) |
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
| F-17 | Staff/official accounts bypass age separation | OPEN — unresolved owner decision (policy deliberately unchanged in v1.29.2 and v1.29.3; `canContact` still exempts owner/admin/official, so the anonymous-message checks inherit that exemption) |
| F-18 | Stars minor hardening | OPEN |
| F-19 | Game registry isolation gaps | OPEN |
| F-20 | Public /api/health | OPEN (note only) |
| F-21 | Seed script vs 60 s limit | OPEN (unverified) |

Correction of an earlier statement: the v1.29.2 report (section 5.4 below) said F-02 was "FIXED". The independent audit of v1.29.2 showed that was too strong: it covered compose, reply, resume and the pre-insert check, but not the `anon:read` notice, and the resume-after-onboarding path never worked in the real onboarding flow (it only worked in tests that built the context by hand).

## 2. v1.29.3 change record (Task 3: complete F-02 only)

Changed / added / deleted files (diff against the delivered v1.29.2 archive; no file deleted):
- `src/features/anonMessages/index.ts` — modified
- `src/db/models/anonMessages.ts` — modified (`createAnonMessage` takes optional `{session, id}`)
- `src/db/models/blocks.ts` — modified (`isBlockedEitherWay` takes an optional trailing `session`; behaviour without it is identical)
- `src/db/models/user.ts` — modified (`getUser` takes an optional trailing `session`; behaviour without it is identical)
- `tests/regression/v1293-anon-complete.test.ts` — added (18 tests)
- `docs/AUDIT_v1.29.3.md` — added (this file)
- `CHANGELOG.md` — modified
- version strings 1.29.2 → 1.29.3: `src/config/version.ts`, `package.json`, `public/miniapp/sw.js`, `public/miniapp/core.js`, `public/miniapp/index.html`
- NOT modified: `package-lock.json` (still carries 1.28.2 as before; no lockfile change was needed, and `npm ci` succeeded with it unchanged).

### 2.1 `anon:read` notification
Before: the «خوندم» handler marked the message read, answered "به فرستنده اطلاع داده شد ✅" immediately, and then sent the notice to the sender with no authorization check and `.catch(() => {})`.
Now: the read status is stored (recipient only, once, unchanged). Then `mayWriteNow(reader, sender)` is evaluated with fresh database reads (existing `canContact` + existing `isBlockedEitherWay`; sender banned/missing also means no notice). The notice is sent only if allowed; the callback answer is decided afterwards: "به فرستنده اطلاع داده شد ✅" only if `sendMessage` really succeeded, otherwise "خوانده شد ✅" (no mention of age or block); a second tap still says "قبلاً خوانده شده ✅". Stale callback data therefore cannot bypass the current rules because nothing is trusted from the button except the message id, and the recipient check is in `markAnonMessageRead`.

### 2.2 Authorization → write race
Flow reviewed: text handler early check (`mayWriteNow`) → rate limit → quote lookup → `deliver()` → [new] one transaction { `mayWriteNow` with the session, `insertOne` with the session } → commit → Telegram `sendMessage` → on failure the record is deleted.
Changes: (a) the final check and the insert are in one `runInTransaction`; a refusal throws `TxAbort`, which aborts the transaction (no record); (b) the record `_id` is `<fromId>:<telegram message_id>` (for new messages and replies), so the same Telegram message processed twice, concurrently or later, hits the unique `_id` (code 11000), is reported as "duplicate", and produces no second record and no second delivery. Existing records keep their random ids. This needs no schema change or migration (`_id` was already a string).
**Remaining limitations (not eliminated):**
1. MongoDB snapshot isolation does not make a concurrent block (`blocks` collection) or age edit (`users` collection) conflict with this transaction, because the transaction writes neither of those documents (write skew). A block that commits after the transaction's snapshot but before its commit is not detected. Closing this needs a document that both paths write (a lock/version document), i.e. a design decision that was not authorized.
2. The Telegram `sendMessage` happens after the commit and cannot be part of any transaction. A block that lands between commit and the send still results in a delivery.
3. A crash between commit and `sendMessage` leaves a stored record that was never delivered (pre-existing behaviour); a retry of the same Telegram message is then treated as a duplicate and is not re-sent (at-most-once delivery was chosen over a possible double delivery).
4. On the fake Mongo harness there is no real isolation, so the tests prove structure (one transaction, aborted on refusal, no record) and application-level ordering, not real concurrency behaviour on a replica set.

### 2.3 Pending link after onboarding
Root cause (reproduced by the new test O1 on the v1.29.2 tree): `bot.ts` loads `ctx.dbUser` at the start of the update. In the nickname handler `setNicknameOnce()` completes onboarding in the database, but `ctx.dbUser` still says `NICKNAME_PENDING`; `resumePendingAnon(ctx)` returned immediately on `ctx.dbUser?.onboardingStep !== "COMPLETED"`, so a new user who came through a link never got the compose step. (The v1.29.2 tests built the context by hand with the finished state and could not see this.)
Fix: `resumePendingAnon` reads the current user from the database, returns if onboarding is not completed there (the pending link stays), refreshes `ctx.dbUser`, then claims the pending link atomically with `takePendingTarget` (find-and-delete) before re-checking age band + blocks and opening the compose step, so onboarding completion and force-join verification cannot both continue the same link. `nickname.ts` and `completion.ts` were not touched.

### 2.4 Tests (`tests/regression/v1293-anon-complete.test.ts`, 18)
R1–R7 read notice (normal, block either direction, age change both sides, undeliverable notice, foreign/stale/banned callbacks, stale reply button, reply flow opened before a block). T1 authorization change after the early check and before the final check (refused inside the transaction, aborted count asserted); T2 one transaction per delivery; C1–C4 concurrent/duplicate/different messages/delivery failure; O1–O5 real onboarding path through the bot (language → gender → age → province → city → nickname), age mismatch, block during onboarding, atomic resume, unfinished-onboarding user with a lying stale context.
On the unfixed v1.29.2 tree: 5 pass / 13 fail (R2–R5, T1, T2, C1, C3, O1–O5). On v1.29.3: 18/18.

### 2.5 Evidence (all executed in this session on the fake Mongo / fake Telegram harness)
- `npx tsx --test tests/regression/v1293-anon-complete.test.ts` → 18 tests, 18 pass.
- `npm test` → 483 tests, 483 pass, 0 fail (465 before + 18 new).
- `npx tsc --noEmit` → exit 0. `npm run build` → exit 0 (output directory removed afterwards).
- `npm ci` in a fresh copy (no node_modules) → exit 0; `package-lock.json` unchanged; in that copy `tsc --noEmit` exit 0 and the v1.29.2 + v1.29.3 focused tests (40) pass. `npm ci` printed `npm audit` warnings about dependencies; nothing was changed because of them.
- NOT executed: any test against real MongoDB (replica set), real Telegram, or Vercel; any load or concurrency test on a real database.

### 2.6 Open observations (not fixed — outside this task's scope)
- F-17: staff/official exemption in `canContact` unchanged; unresolved owner decision.
- A user who completes onboarding in the Mini App (instead of the bot) does not trigger `resumePendingAnon` anywhere (the function is called only from the bot onboarding completion and the force-join button); the stored link then expires after 24 h. Not touched.
- F-08 (open anonymous chats are not re-checked on age change) and F-01 remain open.

---

## 3. Prompt history, verbatim

### 3.1 Request A (v1.29.0 work, Persian)

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

### 3.2 Request B (v1.29.1 work, Persian)

````text
رو دکمه
به یه ناشناس وصلم کن

یکم کار کن
تایمر درست کار نمیکنه
وقتی دونفر همزمان میزنن رو دکمه به یه ناشناس وصلم کن و جنسیت رو انتخاب می‌کنند
ربات به باگ میخوره و برا شخص سوم که میخواد بره تو بات دکمه ای رو بزنه کار نمیکنه


از اول بررسی عمیق کن مشکلشو برطرف کن
````

### 3.3 Task 1 — read-only audit brief (copied from the attachment `e1784dc4-attachment.txt`)

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

### 3.4 Task 2 — fix F-05 and F-02 only (as sent in the session)

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

### 3.5 Task 3 — complete F-02 (copied from the attachment `63c7e873-attachment.txt`)

````text
Task 3 — MoyaGram v1.29.2 → v1.29.3

Complete the Remaining F-02 Anonymous Messaging Security Fixes

Hello Claude,

ChatGPT is acting as the project's senior technical manager and independent security auditor. You are the implementation engineer. The project owner has authorized this narrowly scoped task.

Your job is to complete the remaining F-02 issues identified during the independent audit of v1.29.2.

1. Fix the "anon:read" notification bypass

- Re-check the current age-band eligibility and bilateral block status before notifying the sender that an anonymous message has been read.
- If communication is no longer permitted, update the local read status if appropriate, but do not send a read notification to the other user.
- Ensure the UI response does not falsely claim that a notification was delivered.
- Do not allow stale callback data to bypass current authorization checks.

2. Address the TOCTOU race in anonymous message delivery

- Review the complete flow from the final authorization check through database insertion and Telegram delivery.
- Minimize the authorization-to-write race window.
- Use an atomic or transaction-based approach where supported by the existing architecture.
- If a fully atomic solution is impossible because of external Telegram API boundaries, explicitly document the remaining limitation.
- Never claim that checking immediately before insertion completely eliminates the race.
- Preserve idempotency and prevent duplicate messages or records during retries.
- Do not introduce a new database architecture or unrelated schema migration without explicit approval.

3. Fix pending anonymous-link resumption after onboarding

- Investigate the stale "ctx.dbUser" issue after "setNicknameOnce()" completes onboarding.
- Ensure the updated user state is available before "resumePendingAnon(ctx)" checks onboarding status.
- Alternatively, safely retrieve the current user state from the database.
- Add a regression test that executes the actual onboarding completion path, not merely a manually prepared Context.
- Verify that pending anonymous links resume exactly once and cannot bypass current age/block checks.

4. Add missing regression tests

Add focused tests for:

- Read notification after a bilateral block.
- Read notification after an age-band change.
- Authorization changes between the final check and database insertion.
- Concurrent delivery attempts and duplicate prevention.
- Actual onboarding completion followed by pending-link resumption.
- Permission and eligibility checks after stale callback interactions.

Tests must assert actual observable outcomes, including database writes and Telegram delivery attempts. Avoid tautological assertions that are always true.

5. Strict scope and regression requirements

- Only modify files directly required for F-02.
- Do not modify F-01, F-03 through F-21, or unrelated modules.
- Do not change game logic, wallet, Jeton, Stars payments, backgammon, chat, profiles, social features, or admin functionality except where strictly necessary for the authorized F-02 fix.
- Do not enable wagering or introduce betting functionality.
- Do not perform global string replacements.
- Preserve existing user data, settings, database compatibility, and current Persian UI text unless a change is strictly necessary.
- Maintain backward compatibility.
- Do not silently change staff/official account exemptions. Keep the existing policy and report it as an unresolved owner decision under F-17.

6. Verification requirements

Run and report:

1. Focused regression tests.
2. Full "npm test".
3. "npx tsc --noEmit".
4. "npm run build".
5. "npm ci" in a clean environment, if feasible.
6. A diff review confirming no unrelated files or behaviors changed.

Clearly distinguish:

- Tests actually executed and passed.
- Tests not executed.
- Mock-based tests.
- Real MongoDB/Telegram integration tests.
- Remaining race conditions and architectural limitations.

Do not claim real integration or production-scale verification based on mocks.

7. Version and delivery

- Target version: v1.29.3.
- Update version references consistently in the files that legitimately require version updates.
- Do not make unrelated package or dependency changes.
- Do not modify "package-lock.json" merely to make its version string look consistent. If a legitimate lockfile correction is required, explain why and show the exact diff first.

Deliver:

1. Complete updated project ZIP.
2. Exact list of changed, added, and deleted files.
3. Per-fix technical explanation.
4. Test results with actual commands and outputs.
5. Remaining risks and unresolved items.
6. Updated cumulative audit tracker, preserving all previous findings and their original status history.
7. The exact prompt history and implementation reports. Do not reconstruct or paraphrase previous prompts while presenting them as verbatim originals.

Important: Do not start F-01 or any other open audit finding. This task is exclusively for completing F-02.

If any requirement cannot be implemented safely within this scope, stop and explain the blocker instead of introducing an unapproved workaround.
````

---

## 4. Implementation reports given to the owner, verbatim (assistant's final messages of each delivery)

### 4.1 v1.29.0 delivery report

````text
همه‌ی خواسته‌ها تو نسخه‌ی **1.29.0** انجام شد و فایل `nava-project-v1.29.0.zip` رو فرستادم. تایپ‌چک تمیزه و ۴۳۵ تست پاس شدن (چند تست قدیمی که رفتار قبلیِ تایید رو چک می‌کردن به قوانین جدید تغییر دادم). روی تلگرام واقعی تست نشده؛ تست‌ها با تلگرام و دیتابیس شبیه‌سازی‌شده اجرا شدن.

**۱. عکس و نام بدون تایید**
- عکس و نام فوری اعمال می‌شن (هم تو ربات هم تو مینی‌اپ).
- یه نسخه برای مالک/کانال مدیریت میاد با **فقط یه دکمه‌ی شیشه‌ای «عدم تأیید»**، بدون دکمه‌ی تایید.
- با زدنش، عکس کاربر پاک می‌شه (فقط اگه هنوز همون عکس باشه) یا نام به نام قبلی برمی‌گرده. برای کاربر هم پیام «به دلیل عدم رعایت قوانین…» می‌ره.
- تغییر **سن** هنوز با تایید مالکه، چون فقط عکس و نام رو گفتی.
- متن پیام بعد از «عدم رعایت» ناقص بود؛ من «قوانین» رو گذاشتم. اگه متن دیگه‌ای می‌خوای بگو.

**۲. 🪙 مدیریت ژتون (مالک)**
- سه دکمه‌ی شیشه‌ای باز می‌شه: **کم‌فعالیت‌ها** (تعداد روز)، **جنسیت** (دختر/پسر)، **کاربر یا کاربران مشخص** (آیدی عددی).
- هر کدوم می‌پرسه تعداد ژتون، بعد پیام، بعد «پیام دوم هم بفرستم؟»، بعد خلاصه و تایید.
- به کاربر فقط همون پیام(های) خودت می‌ره. پیام «شارژ شدید» نمی‌ره.
- تو کانال لاگ برای کل ارسال فقط یه پیام خلاصه میاد (تعداد نفر، ژتون هر نفر، مجموع).
- ژتون هر نفر دقیقاً یه بار ثبت می‌شه، حتی اگه ارسال وسط کار قطع بشه. اگه تعداد زیاد بود، دکمه‌ی «▶️ ادامه‌ی ارسال» میاد و کران روزانه هم ادامه می‌ده.
- من یه دکمه‌ی چهارم هم اضافه کردم، «تعدیل دستی یک کاربر»، تا کسر ژتون قبلی از دست نره. ادمین‌های غیرمالک همون روند قبلی رو دارن.
- استفاده از مینی‌اپ هم «فعالیت» حساب می‌شه، وگرنه کسی که فقط مینی‌اپ می‌زد کم‌فعال به نظر می‌رسید.

**۳. باگ بج:** پالسِ مینی‌اپ بج و تیک کاربر رو اصلاً نمی‌خوند، برای همین خودِ کاربر تا بستن و باز کردن برنامه بجش رو نمی‌دید. درست شد. بج تو کارت‌های مچ هم نشون داده می‌شه. سقف انتخاب بج تو مینی‌اپ ۶ بود ولی سرور ۸ می‌گرفت؛ هر دو ۸ شدن.

**۴. عکس پروفایل**
- عکس دکمه‌ی پروفایل همون عکس صفحه‌ی مینی‌اپه؛ یه عکس ذخیره می‌شه و دوباره درخواست نمی‌شه.
- کسی که فقط عکس پیش‌فرض داره، تو پروفایل ربات و بعد از ثبت‌نام دکمه‌ی «📸 ثبت عکس پروفایل» می‌بینه. این دکمه‌ست، اجباری نیست؛ اگه می‌خوای قبل از ادامه‌ی کار اجباری بشه بگو.
- پست عکس پروفایل حذف نمی‌شه، از منوی ⋮ می‌شه کپشنش رو گذاشت یا عوض کرد. بقیه‌ی پست‌ها قابل حذفن. وقتی عکس عوض بشه، کپشن قبلی پاک می‌شه.

ورژن تو ۷ جای لازم بالا رفته و CHANGELOG هم نوشته شده.
````

### 4.2 v1.29.1 delivery report

````text
نسخه ۱.۲۹.۱ آماده است و چند باگ واقعی تایمر و پیام جستجو را درست کرده، ولی علت اصلی «دکمه برای نفر سوم کار نمی‌کند» را پیدا نکردم. تست‌ها هم روی MongoDB شبیه‌سازی‌شده اجرا شده‌اند، نه روی MongoDB واقعی و Vercel؛ تراکنش‌های همزمان واقعی آن‌جا تست نشده‌اند.

**چیزهایی که پیدا و درست شد:**
- **تایمر می‌پرید:** عدد بعد از هر تیک با تأخیر شبکه جابه‌جا می‌شد (۲، ۵، ۷، ۱۰). حالا ثابت ۲، ۴، ۶، … نشان داده می‌شود.
- **شروع ۴۰ ثانیه:** از لحظه‌ی فشردن دکمه حساب می‌شود، نه از لحظه‌ی شروع شمارش. قبلاً گاهی TTL مونگو ردیف صف را چند ثانیه قبل از پایان پاک می‌کرد. نتیجه‌اش این بود که تایمر روی ۳۸ می‌ماند و پیام «کسی پیدا نشد» نمی‌آمد.
- **پیام «در حال جستجو» یخ‌زده:** اگر طرف مقابل کاربر را وصل می‌کرد یا کاربر دوبار پشت‌سرهم می‌زد، پیام قدیمی با تایمر و دکمه‌ی لغوِ مرده می‌ماند. حالا هر جستجو پیام وضعیت خودش را در همه‌ی حالت‌های پایانی پاک می‌کند.
- **حذف پیام وضعیت:** اگر کاربر پیام وضعیت را پاک می‌کرد، کل جستجو بی‌صدا متوقف می‌شد. حالا فقط عدد ادیت نمی‌شود و جستجو ادامه دارد.

**چیزی که پیدا نکردم:** با موتور جستجو و وبهوک را خط‌به‌خط خواندم و همین سناریو را روی شبیه‌ساز زدم. دو نفر با جنسیت مخالف همزمان و یک نفر سوم که دکمه می‌زند، درست کار کرد؛ فقط همین‌ها را ۵ بار پشت‌سرهم تکرار کردم. اگر بعد از این نسخه هنوز اتفاق افتاد، لاگ‌های Vercel همان لحظه (خطوطی که با `[nava:webhook]` و `[search]` شروع می‌شوند) و ساعت دقیقش را بفرست.

هشت تست جدید در `v1291-search.test.ts` اضافه شد و کل ۴۴۳ تست پاس است. نسخه و changelog به‌روز شد.

فایل: `/home/claude/out/nava-project-v1.29.1.zip`
````

### 4.3 Task 1 audit summary message

````text
گزارش کامل ممیزی نسخه ۱.۲۹.۱ آماده است: `MOYA_AUDIT_v1.29.1.md`. این فقط خواندن بود و هیچ فایل پروژه تغییر نکرده. بررسی کردم که بعد از تحویل zip هیچ فایلی عوض نشده است. به تلگرام، مونگو، ولت یا ورسل واقعی هم وصل نشدم.

**محدودیت‌های ممیزی:**
- تست‌ها را در این ممیزی دوباره اجرا نکردم. آخرین اجرا، همان ۴۴۳ تست سبز موقع تحویل ۱.۲۹.۱، همه روی شبیه‌ساز مونگو بود. تست واقعی روی مونگو و تست بار هیچ‌کدام وجود ندارد.
- دو بخش از بررسی (ژتون/بازی/پرداخت و ادمین/امنیت) را خودم مستقیم از روی کد خواندم، چون زیرعامل‌ها به محدودیت استفاده خوردند. بخش‌هایی که فقط از گزارش زیرعامل آمده یا دوباره خوانده نشده در گزارش علامت دارند.
- نخواندم: `broadcastProcessor`، جزئیات `jetonMass`، اعتبارسنجی آپلود، کد سمت کلاینت Mini App.

**یافته‌های مهم** (مورد بحرانیِ اثبات‌شده نداشتیم):
- **سن در لایه اجتماعی:** پروفایل، فید، پست، استوری، کامنت، پاسخ استوری، فالو و عکس هیچ چک بازه‌ی سنی ندارند (F-01). لینک پیام ناشناس هم سن و بلاک را چک نمی‌کند (F-02). مسیرهای تماس و کشف (مچ، درخواست چت، DM، هدیه، جستجو) درست اعمال می‌شوند.
- **سیستم کد خطا وجود ندارد (F-03):** نه کد یکتا، نه گزارش در کانال لاگ، نه پیام فارسی همراه کد. بعضی لاگ‌ها هم خطای خام را چاپ می‌کنند.
- **کیف‌پول بازی (F-04):** سوئیچ «غیرفعال» فقط در `hold` چک می‌شود. `pay`، `refund` و `settleWinner` چک نمی‌کنند و `settleWinner` مبلغ دلخواه را بدون تطبیق با holdها واریز می‌کند. مسیر قابل‌سوءاستفاده‌ای در کد فعلی پیدا نکردم؛ این ضعف قرارداد است برای بازی‌های بعدی.
- **دور زدن دسترسی ادمین (F-05):** دکمه‌های `photomod:ban` و `photomod:delete` فقط `isAdmin` را چک می‌کنند و در جدول دسترسی نیستند.
- **لینک عکس (F-06):** لینک‌های امضاشده‌ی عکس هیچ‌وقت منقضی نمی‌شوند و تا یک سال در کش CDN می‌مانند؛ عکسی که با «عدم تأیید» حذف شده هم می‌تواند همچنان نمایش داده شود.
- **رسید ولت (F-07):** رسید کانال لاگ قبل از ارسال علامت می‌خورد، پس با قطع ناگهانی گم می‌شود. واریزهای بی‌کاربر هم ابزار پیگیری ندارند.

بقیه (چک سن هنگام تغییر سن وسط چت، لابی تخته‌نرد، تطبیق دفتر کل با موجودی، تراکنش‌های واقعی، مقیاس، کران‌های روزانه، README قدیمی) و نقشه وابستگی، وضعیت تست‌ها، امکان‌سنجی VPS و نقشه راه اولویت‌بندی‌شده در گزارش هستند.

باگ «دکمه برای نفر سوم کار نمی‌کند» هنوز بازتولید نشده. برای این مورد لاگ‌های ورسل همان لحظه لازم است.

**سه تصمیم از شما لازم است:**
- در F-01: محتوای بین بازه‌های سنی کامل پنهان شود یا فقط خواندنی بماند؟
- در F-17: ادمین‌ها از جداسازی سنی مستثنا بمانند؟
- در F-04: تقویت قرارداد کیف‌پول بازی با تست‌های بازی‌های قدیمی تخته‌نرد هماهنگ شود؟

قبل از تأیید شما هیچ پیاده‌سازی‌ای شروع نمی‌کنم.

فایل: `/tmp/claude-0/-home-claude/e4e2ec71-c530-5a84-b027-1260e9d1c484/scratchpad/MOYA_AUDIT_v1.29.1.md`
````

### 4.4 v1.29.2 (Task 2) delivery report

````text
نسخه‌ی v1.29.2 آماده است (`nava-project-v1.29.2.zip`، بدون `node_modules`) و فقط F-05 و F-02 در آن اصلاح شده‌اند. همه‌ی تست‌ها روی Mongo و Telegram ساختگی اجرا شده‌اند. هیچ تست یا بررسی‌ای روی MongoDB، Telegram یا Vercel واقعی انجام نشده است.

## ۱. فایل‌های تغییرکرده
مقایسه‌ی zip نسخه‌ی ۱.۲۹.۱ با ۱.۲۹.۲ فقط همین‌ها را نشان می‌دهد:
- `src/features/admin/permGate.ts`
- `src/features/photo/chatPhotoModeration.ts`
- `src/features/anonMessages/index.ts`
- `tests/regression/v1292-anon-photomod.test.ts` (جدید)
- `docs/AUDIT_v1.29.2.md` (جدید)
- `CHANGELOG.md`
- شماره‌ی نسخه در `src/config/version.ts`، `package.json`، `public/miniapp/sw.js`، `public/miniapp/core.js` و `public/miniapp/index.html`

`package-lock.json` را دست نزدم. از قبل روی ۱.۲۸.۲ بود و در نسخه‌های ۱.۲۹.x هم بالا نرفته بود. فقط همین دو فایل بالا نیامده و شماره‌ی بقیه‌ی فایل‌ها بالا رفت.

## ۲. توضیح فنی
**F-05:**
- `photomod:delete` به مجوز `users` و `photomod:ban` به مجوز `ban` در جدول `permGate.ts` نگاشت شد. قبلاً این دو در جدول نبودند، برای همین گیت مجوز اصلاً اجرا نمی‌شد.
- در `chatPhotoModeration.ts` هر دو handler حالا هم `isAdmin` را می‌خواهند و هم `mayDo(ctx, مجوز)` را.
- لغو مجوز بین دو فشار دکمه فوراً جلوی اجرا را می‌گیرد، چون مجوز در هر فشار دوباره خوانده می‌شود.
- مجوز هیچ اکشن دیگری عوض نشد.

**F-02:**
- تابع جدید `mayWriteNow(from, to)` هر دو کاربر را تازه از دیتابیس می‌خواند. اگر کاربری وجود نداشته باشد، گیرنده بن باشد یا کاربر به خودش بنویسد، رد می‌شود. بعد همان `canContact` سیاست سنی موجود (سن نامعلوم یا نامعتبر رد می‌شود) و همان `isBlockedEitherWay` بلاک دوطرفه را اجرا می‌کند. منطق جدیدی ننوشتم.
- این چک در این نقاط اجرا می‌شود:
  - شروع نوشتن
  - بعد از عضویت اجباری
  - ادامه‌ی لینک معلق بعد از ثبت‌نام یا عضویت
  - دکمه‌ی پاسخ
  - هر پیام متنی
  - دقیقاً قبل از `createAnonMessage`
- در صورت رد، هیچ رکوردی ساخته و هیچ چیزی تحویل داده نمی‌شود. پیام فقط این است: «امکان ارسال پیام ناشناس به این کاربر وجود نداره.» و به سن یا بلاک اشاره‌ای ندارد.

## ۳. نتایج تست (همه اجراشده)
- `npx tsx --test tests/regression/v1292-anon-photomod.test.ts`: ۲۲ از ۲۲ موفق.
- همین تست‌ها روی کد اصلاح‌نشده‌ی ۱.۲۹.۱: ۹ موفق و ۱۳ ناموفق. یعنی تست‌ها واقعاً باگ‌ها را تشخیص می‌دهند.
- `npm test`: ۴۶۵ تست، ۴۶۵ موفق، ۰ ناموفق (۴۴۳ قبلی به‌علاوه‌ی ۲۲ جدید).
- `npx tsc --noEmit`: بدون خطا.
- `npm run build`: بدون خطا. پوشه‌ی `dist` را بعد از build پاک کردم تا در آرشیو نیاید.

تست‌ها هر مورد خواسته‌شده را پوشش می‌دهند: ادمین با و بدون مجوز، غیرادمین، هم‌بازه‌ی سنی، بازه‌ی متفاوت، سن نامعتبر، بلاک از هر دو طرف، تغییر سن یا بلاک بعد از باز شدن لینک، پاسخ‌ها، ادامه‌ی لینک معلق و نبودن رکورد یا تحویل هنگام رد شدن.

اجرا نشده: هر تست روی MongoDB، Telegram یا Vercel واقعی.

## ۴. ریسک‌های باقی‌مانده
- بین چک نهایی و ساخت رکورد پنجره‌ی بسیار کوچکی هست. دو خواندن جدا از هم‌اند و در یک تراکنش نیستند. این پنجره کم شده، ولی صفر نشده است.
- حساب‌های staff و official در `canContact` معاف‌اند (F-17). این تصمیم مالک است و تغییر ندادم.
- چت ناشناس بازشده هنوز بعد از تغییر سن دوباره چک نمی‌شود (F-08). در این کار نبود.
- بقیه‌ی یافته‌ها (F-01، F-04، F-06، F-07 و بقیه) باز مانده‌اند و هیچ اصلاح دیگری شروع نشد.

## ۵. تاریخچه‌ی تجمیعی
در `docs/AUDIT_v1.29.2.md` است و شامل این بخش‌هاست:
- جدول وضعیت F-01 تا F-21: F-02 و F-05 «اصلاح‌شده در ۱.۲۹.۲»، بقیه «باز».
- متن کامل چهار پرامپت بدون ویرایش: درخواست A، درخواست B، Task 1 و Task 2.
- گزارش کامل ممیزی ۱.۲۹.۱ بدون تغییر.
- اشاره به سندهای ممیزی قبلی داخل پوشه‌ی `docs`.

پرامپت Task 1 را از متن همین گفتگو بازنویسی کردم، چون فایل پیوست اصلی (`e1784dc4-attachment.txt`) در دسترس نبود. اگر نسخه‌ی اصلی‌اش را دارید، کافی است با آن مقایسه کنید.
````

---

## 5. Complete content of the previous cumulative file `docs/AUDIT_v1.29.2.md` (unchanged), which in turn contains the full v1.29.1 audit report (F-01…F-21)

``````markdown
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

``````

## 6. Older audit documents kept unchanged in this folder

- `docs/AUDIT_v1.16.1.md`
- `docs/AUDIT_v1.16.3.md`
- `docs/AUDIT_v1.17.0.md`
- `docs/AUDIT_v1.27.1.md`
- `docs/AUDIT_v1.28.0.md`

````````

## 6. Older audit documents kept unchanged in this folder

- `docs/AUDIT_v1.16.1.md`
- `docs/AUDIT_v1.16.3.md`
- `docs/AUDIT_v1.17.0.md`
- `docs/AUDIT_v1.27.1.md`
- `docs/AUDIT_v1.28.0.md`
