# AUDIT v1.29.6 — independent audit, performance review, safe-deployment improvements

Engineer: Claude (implementation). Baseline: nava-project-v1.29.5.zip. Result: `nava-project-v1.29.6-full.zip`.
**Not claimed:** production-ready, one-million-user ready, fully secure, zero bugs. All database/Telegram tests are MOCK tests (fake Mongo/Telegram harness). No real MongoDB, Telegram, Vercel or production access was available; a real MongoDB could not be started in the sandbox.

## 1. Verdict
v1.29.6 closes the concrete gaps found in the independent audit (stale-lease double prompt, legacy callback exposure, game lobby age separation, unbounded external calls, raw error logging, shared-cache media, missing job/API monitoring, lock-file drift). Several larger items remain open or BLOCKED by owner decisions (below). Mock-tested only.

## 2. Verification evidence (actual runs, `npm run verify:ci`)
| Step | Result |
|---|---|
| versions + lock consistency | PASS (1.29.6 in package.json, lock ×2, version.ts, CHANGELOG, core.js, sw.js, index.html ×15) |
| secret scan | PASS |
| mini app static checks | PASS |
| `npm ci` (real install) | PASS |
| `npm run typecheck` | PASS |
| `npm test` | 546 tests, 546 pass, 0 fail (includes 37 new v1.29.6 tests; 1 older test updated deliberately, see section 4) |
| `npm run build` | PASS |
| `npm audit --omit=dev --audit-level=high` | exit OK: 0 high/critical; 2 moderate remain (exceljs→uuid; the offered "fix" is a breaking downgrade to exceljs@3.4.0, not applied) |
Before the update `@vercel/functions` pulled 4 high transitive advisories (zod chain); `npm update` within semver fixed them.
Mutation checks (on a copy): removing the lease-token check or the legacy upgrade makes the new anon tests fail; the baseline game code fails the new game-age tests.

## 3. Findings and changes
| ID | Finding | Status |
|---|---|---|
| N-1 | Lock/root version drift (lock said 1.28.2, root 1.23.0) | FIXED (`npm install --package-lock-only`; `check-versions` guards it) |
| N-2 | Stale lease holder could send a 2nd compose prompt / overwrite a newer flow | FIXED: atomic `completePendingWithFlow` (transaction, token-checked); lease 90 s > webhook maxDuration; inbox lease 60→90 s |
| N-3 | v1.29.3 buttons still carry sender Telegram id | FIXED lazily on first press by the true recipient (opaque `cbId`; revoked if the keyboard edit fails; strangers cannot trigger an upgrade). Messages never pressed keep the old button (cannot be edited without the chat message id) |
| N-4 | Backgammon lobby/join ignored age band/block/ban (F-09) | FIXED for members (fresh DB read, `canContact`, fail closed). Guests unchanged — owner decision |
| N-5 | Unbounded external fetch / Telegram API calls | FIXED (fetchWithTimeout, Telegram client timeouts, Mongo connect/queue/idle timeouts) |
| N-6 | Raw error objects in logs (F-15/F-03) | FIXED for 19 sites + code catalogue `docs/ERROR_CODES.md` (log-channel reporting of codes not added) |
| N-7 | User media cached `public, s-maxage=1y` | FIXED: `private` for revocable media (F-06 partial) |
| N-8 | Health endpoint cacheable / any method | FIXED |
| N-9 | No job/cron/payment/API/RUM monitoring (F-13, F-20) | FIXED in monitoring (alerts with cooldown + storm cap) |
| N-10 | No ledger↔balance reconciliation (F-10) | PARTIALLY FIXED: read-only tool `npm run reconcile-ledger`; not scheduled; never corrects |
| N-11 | `@vercel/functions` advisories | FIXED (semver update) |

## 4. Deliberate test change
`v1294-anon-privacy-pending` L3 expected the old non-atomic order. It now asserts atomic semantics: a crash leaves no flow and the link remains; retry yields exactly one flow and one prompt.

## 5. 31 performance recommendations
| # | Item | Status | Note |
|---|---|---|---|
| 1,22 | Code splitting (duplicate item) | DEFER | classic ordered scripts, no bundler; RUM data first |
| 2 | WebP/AVIF | DEFER | media comes from Telegram uploads; needs a conversion pipeline + owner decision |
| 3 | Duplicate requests | DEFER | no measured evidence; RUM now collects data |
| 4 | Debounce | DEFER | not found as a measured problem |
| 5 | Pagination | PARTIALLY IMPLEMENTED | search lists use skip/limit pages; explore cursor DEFER |
| 6 | CDN | PARTIALLY IMPLEMENTED | Vercel edge for static; media policy corrected to private |
| 7 | Job queues | ALREADY IMPLEMENTED | durable inbox, broadcast and jeton jobs with leases |
| 8 | N+1 in search | NOT APPLICABLE | `userSearch.ts` issues single bounded `find`s; no per-row query found |
| 9 | Compression | NOT APPLICABLE | platform-level |
| 10 | Redis | DEFER | no demonstrated need; adds a dependency/infra |
| 11 | Unused deps | DEFER | no depcheck evidence run |
| 12 | Timeouts | IMPLEMENT (done) | section 3 N-5 |
| 13 | AI streaming | NOT APPLICABLE | no streamed LLM responses in the product |
| 14 | Dependency updates | PARTIALLY IMPLEMENTED | in-range update done; exceljs major change deferred |
| 15 | Lazy images | IMPLEMENT (done) | `NG.img` lazy, feed/profile/explore |
| 16 | Parallel requests | DEFER | no evidence |
| 17 | DB indexes | PARTIALLY IMPLEMENTED | existing indexes; `npm run explain-queries` for owner evidence; no new index created |
| 18 | OpenTelemetry | DEFER | in-house monitoring added instead |
| 19 | Region alignment | DEFER | owner must check Vercel region vs Atlas region |
| 20 | SSR/SSG | NOT APPLICABLE | Telegram Mini App |
| 21 | Deferred scripts | DEFER | order-dependent global `NG` scripts |
| 23 | Virtual lists | DEFER | no evidence of long lists on target devices |
| 24 | UI buttons | DEFER | item too vague to change safely |
| 25 | Mongo pooling | IMPLEMENT (done) | timeouts; pool size unchanged (see MONGODB_POOLING.md) |
| 26 | DOM updates | DEFER | no measurement |
| 27 | Browser/SW caching | PARTIALLY IMPLEMENTED | versioned SW; media cache policy fixed |
| 28 | Load balancing | NOT APPLICABLE | Vercel |
| 29 | Failover | NOT APPLICABLE (owner/Atlas) | Atlas replica set; verify in Atlas |
| 30 | RUM | IMPLEMENT (done) | privacy-preserving |
| 31 | Mobile/slow-network tests | DEFER | manual checklist `docs/MOBILE_TESTING.md` |

## 6. F-01..F-25 status after v1.29.6
| ID | Status |
|---|---|
| F-01 cross-age social surface | BLOCKED — owner policy decision; unchanged |
| F-02 anon links age/blocks | previously fixed (v1.29.3/4); hardened (N-2, N-3); mock-tested |
| F-03 error codes | PARTIALLY FIXED (codes in logs; no channel reporting) |
| F-04 game wallet disabled switch | BLOCKED — unchanged (stakes stay disabled; no wagering enabled) |
| F-05 | FIXED earlier (v1.29.2); not re-changed |
| F-06 signed media URLs | PARTIALLY FIXED (private cache); signatures still non-expiring — owner/perf decision |
| F-07 deposit receipt loss | OPEN, unchanged |
| F-08 age change / relay re-check | OPEN; design: close relay sessions on approved age-band change |
| F-09 backgammon age | FIXED for members; guests = owner decision |
| F-10 reconciliation | PARTIALLY FIXED (read-only) |
| F-11 real-Mongo transactions | NOT VERIFIED (no real Mongo) |
| F-12 hot queries | OPEN; explain script provided |
| F-13 job reliance on cron | PARTIALLY FIXED (monitoring/alerts only) |
| F-14 mini rate limiter fails open | OPEN, unchanged |
| F-15 raw error logs | FIXED (19 sites) |
| F-16 export/import waitUntil | OPEN, unchanged |
| F-17 staff/official exemption | BLOCKED — unchanged |
| F-18, F-19 | OPEN, unchanged |
| F-20 health | FIXED (no-store, methods) |
| F-21 seed vs 60 s | OPEN (unverified) |
| F-22 | FIXED v1.29.4 + legacy upgrade now (N-3) |
| F-23 | FIXED v1.29.4 (not re-changed) |
| F-24 | FIXED v1.29.4; completion now atomic (N-2) |
| F-25 | FIXED v1.29.4 (not re-changed) |
"Unchanged" items were not modified in this release; this audit did not re-prove each one at line level beyond the areas listed in section 3.

## 7. Changed files (summary)
New: `src/utils/fetchTimeout.ts`, `src/utils/safeLog.ts`, `src/services/monitorOps.ts`, `src/services/ledgerReconcile.ts`, `scripts/{verify,check-versions,check-miniapp,check-secrets,smoke-staging}.mjs`, `scripts/{reconcile-ledger,explain-hot-queries}.ts`, `docs/{STAGING,RELEASE_PROCESS,BACKUP_RESTORE,MONITORING,MONGODB_POOLING,PERFORMANCE_AND_TIMEOUTS,MOBILE_TESTING,CI,ERROR_CODES}.md`, tests `v1296-*`.
Modified: `src/db/models/anonMessages.ts`, `src/features/anonMessages/index.ts`, `src/services/games/backgammonGames.ts`, `src/webhook/processUpdate.ts`, `src/db/connect.ts`, `src/bot.ts`, `src/services/{miniapp,monitor}.ts`, `src/services/nava/{media,giftSticker}.ts`, admin files (`giftsAdmin`, `userBackup`, others for log codes), `api/{health,miniapp,webhook}.ts`, `api/cron/*`, `public/monitor/index.html`, mini-app `core.js/main.js/feed.js/profile.js/sw.js/index.html`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `src/config/version.ts`.

## 8. Database changes
Additive only: optional `cbId` on `anon_messages`; new collections `ops_metrics` (TTL) and `monitor_state`. No renames, no destructive migration, no data rewritten. Existing balances/ledger untouched.

## 9. Security / privacy review
Age separation, block/ban checks, admin authorization, payment integrity, F-17 exemption and stakes-disabled state were not weakened. Unknown/invalid age still fails closed. Monitoring/RUM/health expose no secrets, ids or raw errors. Residual: TOCTOU windows, non-expiring media signatures, unverified real-Mongo transaction behaviour.

## 10. Production owner steps
Take an Atlas snapshot → deploy Preview with staging env → `npm run smoke:staging` → test concurrent link opening on staging (real transactions) → run `explain-queries` and `reconcile-ledger` on staging → promote → watch `/monitor`. Decide: F-01, F-17, F-04, guests in game join, media signature expiry, F-08 relay policy, exceljs upgrade.

## 11. Ranked remaining risks
1. F-01/F-17 cross-age social policy (owner). 2. Real-Mongo transaction behaviour unproven. 3. Non-expiring media signatures. 4. F-07 deposit receipt loss. 5. F-08 relay re-check. 6. Hot queries unmeasured. 7. Rate limiter fails open. 8. exceljs moderate advisories.

## 12. Deliberately not implemented
F-01, F-17, F-04 changes; guests in game join; F-08 relay re-check; media signature expiry; search aggregation/explore pagination; code splitting; client-side fetch timeouts; Redis/OTel/SSR/CDN/LB/failover; canary (unverifiable); any production action.

## 13. The Safe Deployment guide
The guide itself was NOT supplied; recommendations were derived from the brief's description only (see RELEASE_PROCESS.md, STAGING.md, BACKUP_RESTORE.md, MONITORING.md). No restore or canary was performed.

## 14. Prompt history
The v1.29.5-era task prompts (Tasks 1–4) are preserved verbatim in `docs/AUDIT_v1.29.4.md` section 3. The full v1.29.6 brief follows verbatim.

### 14.1 Brief (verbatim, attachment 4eec8d0d-attachment.txt)

MoyaGram v1.29.6 — Independent Full Audit, Performance Review & Safe Deployment Improvements

Claude, I am the implementation engineer for this task. ChatGPT is my senior technical project manager and independent auditor. The project owner makes all final product and production decisions.

You are working from the supplied "nava-project-v1.29.5.zip". Treat this exact archive as the source of truth. Do not assume previous audit claims are correct until you verify them against the actual source code.

Your task has three parts:

1. Independently audit the complete v1.29.5 project.
2. Evaluate every recommendation in the supplied 31-item performance checklist and the Safe Deployment guide.
3. Implement the improvements that are demonstrably useful, necessary, safe, and compatible with our actual architecture.

Do not merely produce recommendations. Implement approved, non-blocked improvements in the codebase, add regression tests, and provide a complete implementation report.

---

1. Non-negotiable project rules

- Preserve all existing user data, balances, Jeton ledger entries, settings, profiles, posts, stories, messages, games, active sessions, jobs, and payment records.
- No destructive database migrations.
- No careless global string replacements.
- Do not rename internal database identifiers, collection names, fields, environment variables, or legacy namespaces without a separately justified, backward-compatible migration and explicit owner approval.
- Do not introduce regressions in unrelated modules.
- Keep changes modular and limited to the files that actually need modification.
- Do not rewrite working modules merely to make the code look cleaner.
- Do not enable wagering or real-money/staked gameplay. Keep all existing stake-related protections intact.
- Never weaken age separation, privacy, block checks, moderation, admin authorization, payment integrity, or account security.
- Do not change the F-17 staff/official age exemption.
- Do not invent test results, production access, successful integrations, or deployment verification.
- Mock tests must be explicitly identified as mock tests. They do not prove real MongoDB, Telegram, Vercel, or production behavior.
- Do not use production credentials, production databases, or production users for testing.
- Do not deploy, modify production environment variables, change DNS, or run production migrations.
- If a change requires a product-policy decision or unavailable infrastructure, document it as BLOCKED rather than guessing.

The application currently uses Vercel Serverless + MongoDB + grammY + a static HTML/CSS/JavaScript Telegram Mini App. Adapt every recommendation to this architecture. Do not blindly copy Docker, NGINX, Kubernetes, or GitLab examples into this project.

---

2. Independently audit the complete v1.29.5 project

Inspect the entire repository, including:

- Backend source code
- Mini App source code
- API endpoints
- Database models and indexes
- Authentication and authorization
- Age separation and blocking
- Anonymous messaging
- Social features
- Games and game registry
- Jeton ledger and wallet
- Telegram Stars payments
- Wallet deposits and receipts
- Background jobs, queues, leases, and cron endpoints
- Monitoring and health endpoints
- Environment configuration
- Build and deployment configuration
- Existing tests and historical audit documents
- Package dependencies and lock file

Read and verify the previous audit reports, especially:

- "docs/AUDIT_v1.29.4.md"
- "docs/AUDIT_v1.29.3.md"
- "docs/AUDIT_v1.29.2.md"

Treat historical findings as leads, not proof that the issue still exists.

Specific v1.29.5 checks

1. Verify all F-22 through F-25 changes from v1.29.4.
2. Check whether old anonymous-message callback buttons still expose Telegram IDs and whether a safe compatibility strategy exists.
3. Audit the pending-link lease implementation for stale workers, lease expiry, token validation, duplicate flows, retries, and recovery after crashes.
4. Verify Mini App onboarding resumes pending anonymous links correctly.
5. Verify the final sender and recipient ban checks use fresh database state.
6. Inspect every relevant callback ownership check and forged-callback path.
7. Review the v1.29.5 Mini App changes for UI, accessibility, performance, and regression risks.
8. Verify that the backend and database really remain unchanged where the changelog says they do.
9. Verify version consistency across "package.json", "package-lock.json", "src/config/version.ts", "CHANGELOG.md", "public/miniapp/core.js", "public/miniapp/sw.js", "public/miniapp/index.html", and the archive name.

Known issue to investigate: the supplied archive reports "package.json" version "1.29.5", while "package-lock.json" reports version "1.28.2" and its root package metadata reports "1.23.0". Verify this independently and correct the metadata safely if confirmed.

Do not assume a clean build or successful tests. Run the commands and report the actual results.

---

3. Evaluate all 31 performance recommendations

For every item below, record one of these statuses:

- IMPLEMENT — necessary and justified; implement it.
- ALREADY IMPLEMENTED — verify the actual implementation and identify its files.
- PARTIALLY IMPLEMENTED — explain the remaining gap and implement it if safe.
- NOT APPLICABLE — explain why it does not fit our architecture.
- DEFER — explain what evidence or owner decision is required.

Do not skip any item.

1. JavaScript code splitting.
2. WebP/AVIF image optimization.
3. Elimination of duplicate requests.
4. Search debounce.
5. API pagination.
6. CDN delivery.
7. Background job queues.
8. N+1 database query elimination.
9. Gzip/Brotli compression.
10. Redis caching.
11. Removal of unused dependencies.
12. API and external-request timeouts.
13. AI response streaming.
14. Dependency and security updates.
15. Lazy loading images.
16. Safe parallel requests.
17. Database index optimization.
18. OpenTelemetry observability.
19. Application/database region alignment.
20. SSR/SSG.
21. Deferred script loading.
22. Duplicate code-splitting recommendation.
23. Virtual lists for large collections.
24. Simplification of unnecessary UI buttons.
25. MongoDB connection pooling.
26. Avoidance of unnecessary DOM updates and rendering.
27. Browser and Service Worker caching.
28. Load balancing.
29. Server failover.
30. Real-user performance monitoring.
31. Testing on mobile devices and slow networks.

Important implementation guidance

- Code splitting: inspect the Mini App's actual script loading order and global "NG" dependencies. Do not break module initialization or navigation. Implement lazy module loading only if it produces a measurable benefit and can be regression-tested.
- WebP/AVIF: preserve original uploaded media. Optimize only derived images or thumbnails where supported.
- Duplicate requests: identify actual duplicate API calls and prevent races without suppressing legitimate refreshes.
- Debounce: verify the existing implementation before changing it.
- Pagination: identify every large collection using "skip"/offset pagination. Prefer cursor pagination where it is safe and backward-compatible.
- CDN: use the existing Vercel delivery capabilities. Do not add an unnecessary CDN provider.
- Background jobs: inspect existing durable jobs, leases, retries, and recovery before introducing another queue.
- N+1: investigate "src/services/nava/search.ts" in particular. It contains a potentially expensive pattern of fetching posts separately for multiple users. Confirm whether this is a real bottleneck and, if so, replace it with a bounded batch query or aggregation while preserving filtering, ordering, and output.
- Compression: verify what Vercel already provides. Do not add redundant compression middleware.
- Redis: do not add Redis without measured evidence that MongoDB and existing caches cannot meet the requirement. Avoid introducing unnecessary infrastructure.
- Dependencies: remove only demonstrably unused packages. Do not perform broad major-version upgrades.
- Timeouts: inspect Telegram, MongoDB, wallet, media, and other external calls. Use bounded timeouts and safe retry behavior without duplicating financial or messaging operations.
- AI streaming: do not add it unless an existing product feature genuinely requires it.
- Dependency updates: inspect security advisories and compatibility before upgrading. Keep package and lock files consistent.
- Indexes: do not add indexes based on guesses. Identify hot queries and provide explain-plan evidence from an isolated staging database when available.
- OpenTelemetry: evaluate the operational cost and Vercel compatibility. Do not add a large observability stack without a clear benefit.
- Region alignment: document the required Vercel and MongoDB Atlas region checks. Do not claim to have inspected external account settings.
- SSR/SSG: the Mini App is currently static HTML/JS. Do not migrate frameworks just to follow a generic recommendation.
- Deferred scripts: preserve Telegram SDK and initialization dependencies.
- Virtual lists: implement only where large lists justify the complexity.
- UI buttons: do not remove or rename user-facing buttons without owner approval.
- Connection pooling: inspect "src/db/connect.ts" and calculate the implications of per-instance pools and serverless concurrency. Do not blindly increase "maxPoolSize".
- DOM updates: the Mini App uses vanilla JavaScript, not React. Optimize actual unnecessary DOM work rather than introducing React-specific patterns.
- Browser caching: preserve safe version invalidation. Never allow private user data or revocable media to remain publicly cached.
- Load balancing and failover: use Vercel and MongoDB Atlas capabilities. Do not add NGINX, Kubernetes, or a self-hosted server without an approved architecture migration.
- Real-user monitoring: measure meaningful Mini App and API performance while protecting user privacy.
- Mobile/slow-network testing: add a repeatable test procedure and distinguish browser simulation from real Telegram-device verification.

---

4. Evaluate the Safe Deployment guide

The supplied guide covers:

1. CI/CD pipeline
2. Staging environment
3. Canary deployment
4. Health checks, monitoring, and rollback

Its README describes an educational repository, not a complete production-ready deployment system. Verify the actual contents before reusing anything. Do not treat its sample configuration as production-ready.

4.1 CI and release gates

Create a reliable, repeatable verification command, such as "npm run verify", that runs the appropriate project checks:

- Dependency installation consistency
- TypeScript
- Full test suite
- Production build
- Any additional static or security checks that are justified

If a CI provider is clearly identifiable, add an appropriate CI workflow. If it is not identifiable, do not assume GitLab or GitHub. Provide provider-neutral commands and document the required workflow.

A failed required check must prevent the release pipeline from being considered successful.

4.2 Staging environment

Prepare the project for a genuinely isolated staging environment.

Requirements:

- Separate Vercel Preview/Staging configuration.
- Separate MongoDB database or isolated staging cluster.
- Separate Telegram test bot and webhook.
- Separate secrets and environment variables.
- No production users or financial data.
- No shared production bot token.
- No accidental production webhook changes.
- Safe test data and cleanup procedures.
- Smoke tests for onboarding, authentication, Mini App APIs, anonymous messaging, social features, games, Jeton, payments, and background jobs.

Do not claim staging is operational until the owner configures the external services and verifies them.

4.3 Canary and gradual rollout

Evaluate whether canary deployment is actually supported by our current Vercel architecture and account configuration.

Do not add NGINX or Kubernetes merely because the educational guide uses them.

If weighted canary traffic is not supported or cannot be verified, document the limitation and use a safe Preview → verification → Production promotion process instead.

4.4 Monitoring and health checks

Audit "/api/health", "/api/monitor", the admin monitoring panel, webhook processing, cron jobs, and error reporting.

Improve monitoring where necessary:

- Application availability.
- MongoDB connectivity and latency.
- Webhook failures.
- API error rate and latency.
- Job queue backlog and stale leases.
- Failed payment and wallet operations.
- Mini App performance.
- Cron execution and missing "CRON_SECRET".
- Unexpected resource or connection pressure.

Do not expose secrets, user IDs, private data, database details, or internal error messages through public health endpoints.

Add actionable alerts only where they can be delivered safely and without creating notification storms.

4.5 Backup, restore, and rollback

Create or improve a practical operational runbook covering:

- Full MongoDB Atlas backup.
- Restore into an isolated database.
- Verification of restored collections, document counts, indexes, and critical financial records.
- Recovery procedure and acceptance checks.
- Code rollback.
- Backward-compatible database migrations.
- What a code rollback cannot undo.

The Excel user export is not a complete database backup.

Do not run a real backup, restore, migration, or rollback against production. Do not describe a restore as tested unless it was actually performed against an isolated environment.

---

5. Revisit unresolved historical audit findings

Re-check every finding in "AUDIT_v1.29.4.md" against the current source.

At minimum, investigate:

- F-01: social-layer age separation.
- F-03/F-15: unique error codes and safe structured logging.
- F-04: game wallet stake-operation protections.
- F-06: media URL signing, expiration, revocation, and cache policy.
- F-07: durable wallet receipt notification and unmatched deposit handling.
- F-08/F-09: age re-checks for existing contact/relay paths and game lobby.
- F-10: ledger-to-balance reconciliation.
- F-11: real MongoDB transaction behavior and webhook/inbox lease overlap.
- F-12: query performance and actual scale readiness.
- F-13: cron reliability and recovery latency.
- F-14: Mini App rate-limit behavior during database failures.
- F-16: export/import checkpoint and recovery.
- F-17: staff/official exemption audit.
- F-18: Stars payment hardening.
- F-19: game module boundaries.
- F-20: public health endpoint information exposure.
- F-21: seed script execution time.

Product decisions that must remain blocked

F-01: Do not choose a new cross-age social-content policy. Do not independently decide between hiding cross-band content and read-only access. Document the exact decision required from the owner. Preserve existing safeguards and do not weaken them.

F-17: Do not change the staff/official age exemption. Audit and document it only.

F-04: Keep wagering and stakes disabled. Do not enable settlement or payment behavior for staked games. If legacy financial records require special handling, document the risk instead of guessing.

Financial integrity

For Jeton, Stars, deposits, refunds, and wallet operations:

- Preserve the ledger as the source of truth.
- Never silently modify balances to make reconciliation pass.
- Never issue automatic corrective credits or debits.
- Reconciliation must initially be read-only.
- Any financial correction must be separately authorized, idempotent, transactional, and auditable.
- Do not change existing payment semantics without dedicated regression tests.

Age and privacy safety

- Unknown or invalid age must fail closed wherever age separation is required.
- Do not weaken block checks or final authorization checks.
- Do not expose sender or recipient identity through anonymous-message callbacks.
- Do not trust stale cached user state for final authorization.
- Do not introduce any cross-age contact path.
- Preserve existing privacy protections and test forged callbacks, stale callbacks, and concurrent actions.

---

6. Implementation strategy

Work in controlled stages.

Stage A — Evidence-based audit

Before editing:

1. Inspect the complete repository.
2. Reproduce the existing state.
3. Identify confirmed defects versus historical or speculative findings.
4. Produce a concise implementation matrix.
5. Identify any change that requires owner approval.

Do not spend time rewriting documentation before verifying the actual code.

Stage B — Implement safe, high-value improvements

Implement confirmed improvements that do not require product-policy decisions or production access.

Prioritize:

1. Security and authorization defects.
2. Privacy and age-separation defects.
3. Financial integrity and durable payment notifications.
4. Job recovery and idempotency.
5. Safe error reporting and monitoring.
6. Query performance and unnecessary database round trips.
7. Mini App performance improvements supported by evidence.
8. CI, staging preparation, verification scripts, and operational documentation.

Keep each feature modular. Avoid combining unrelated changes into one large refactor.

For high-risk changes, implement focused tests first, then the smallest safe patch.

If a task cannot be safely implemented without a real MongoDB replica set, Vercel access, Telegram test bot, owner decision, or external account configuration, stop at the code-safe preparation and report the exact missing requirement.

Stage C — Regression and verification

Run and report:

- "npm ci"
- "npm run typecheck"
- "npm test"
- "npm run build"
- "npm run verify" if added
- Relevant focused regression tests
- Any new security and performance tests

Also verify:

- No unrelated module was unintentionally changed.
- No existing user-facing Persian text or button label changed without authorization.
- No existing data was deleted or rewritten.
- No internal identifier was globally renamed.
- No new production secret is required unexpectedly.
- No new service was introduced without justification.
- All package and lock versions are consistent.

If network access prevents "npm ci", report that exact failure and do not claim the remaining commands passed.

Do not treat fake MongoDB or fake Telegram tests as proof of real infrastructure behavior.

---

7. Required final report

Provide a detailed report with these sections:

1. Final verdict: Is v1.29.5 safe to continue from? What prevents production readiness?
2. Independent audit findings: Confirmed, fixed, partially fixed, unresolved, and not reproducible.
3. 31-item performance checklist: Every item with its status, code evidence, and action taken.
4. Safe Deployment checklist: CI, staging, release promotion, monitoring, backup, restore, and rollback.
5. Historical audit findings: Updated status for F-01 through F-21 and F-22 through F-25.
6. Implemented changes: Exact file paths and the reason for each modification.
7. Database changes: Collections, fields, indexes, migration behavior, compatibility, and rollback safety.
8. Security and privacy review: Age separation, anonymous messaging, authorization, blocking, secrets, and financial protections.
9. Performance evidence: Query changes, measured improvements, and what still needs real-world benchmarking.
10. Test evidence: Exact commands, actual results, failures, skipped tests, and limitations.
11. Production requirements: Exact manual steps the owner must perform in Vercel, MongoDB Atlas, and Telegram.
12. Remaining risks: Clearly ranked by severity.
13. Version and changelog: Update all required version references consistently.
14. Full implementation history: Preserve the exact prompts and implementation responses that are actually available. Do not reconstruct missing history or invent earlier instructions.

Include a final table:

Area| Status| Evidence| Remaining action

Use explicit labels:

- VERIFIED
- FIXED
- PARTIALLY FIXED
- NOT VERIFIED
- BLOCKED
- NOT APPLICABLE

Never use "production-ready", "one-million-user ready", "fully secure", or "zero bugs" without evidence that actually supports the claim.

---

8. Deliverables

Return:

1. The updated complete project ZIP, named "nava-project-v1.29.6-full.zip".
2. The full audit and implementation report.
3. A concise list of owner actions required before deployment.
4. A list of changes that were deliberately not implemented and why.

Do not replace the whole project with a simplified version. Preserve all existing files and functionality unless a specific change is necessary and verified.

Final instruction: Be conservative with production risk, aggressive with evidence-based auditing, and precise with implementation. A feature that is already implemented must not be duplicated. A feature that is unnecessary must not be added. A confirmed defect must not be hidden behind a passing mock test. Every change must be regression-tested and independently explainable.

### 14.2 Short user messages
"اینارو انجام بده مو به مو و گزارش بده" / "ادامه بده" / "ادامه بده"
