# MOYA v1.28.0 — Security & Engineering Audit (report)

Method: every finding in the audit prompt was re-verified in the code first; fixes are minimal and backward compatible.
Nothing was deployed, no production DB / Vercel / Telegram was contacted, no production secrets were used. All tests run on the in-memory fake Mongo + fake Telegram harness.

## Findings, severity, evidence, status
| # | Sev | Finding (verified) | Where | Fix | Tests |
|---|-----|--------------------|-------|-----|-------|
| 1 | P0 | Minors / adults could be matched, requested, DMed, gifted, discovered | matching/engine, search, chatRequest, nava/dm, gifts, search | `services/ageBand.ts` + filters at every entry point and again at accept/send time | v128-age-separation (11) |
| 2 | P1 | One Stars order could be paid out more than once (replay / forwarded invoice) | features/payments, db/models/relic.ts | atomic order claim + ledger + balance in one transaction; exception record; first valid payer wins | v128-stars-replay |
| 3 | P1 | Banned user's real `successful_payment` was dropped | bot.ts middleware order | payments composer before ban middleware | v128-stars-replay |
| 4 | P1 | Admin granular permissions not enforced on stale callbacks / flows / mini-app / monitor; banned static admin kept staff rights | features/admin/permGate.ts, services/monitor.ts, api/miniapp.ts, api/monitor.ts, nava/staffMod.ts | central tables + 3 gates; `authenticateStaff` reads DB (ban + effective perms) every request; `staffCan` per action | v128-staff-perms (6) |
| 5 | P1 | Staked backgammon: money risk; TTL index on `createdAt` deleted active/unsettled games after 3 days | services/games/backgammonGames.ts | stakes refused server-side (`STAKE_SWITCH`), legacy waiting tables closed+refunded, TTL index dropped, `purgeFinishedGames` only deletes finished+settled/free; `bg-reconcile` script | v128-game-stakes-off (4) |
| 6 | P1 | Broadcast: no lease, non-CAS cursor → double sends; UI promised "minutes" while cron is daily | services/broadcastProcessor.ts, db/models/broadcast.ts | lease + CAS, per-user checkpoint, transient errors do not skip users, honest text, maxDuration 60 for the cron | v128-broadcast-lease (5) |
| 7 | P1 | **Bot token sent to a third party**: Telegram file URL (contains the token) was passed to Sightengine | services/sightengine.ts | download ourselves, upload bytes; log only the message | v128-moderation-threshold T4 |
| 8 | P2 | Moderation threshold accepted 5 / huge / negative → filter effectively off; NaN scores read as safe | config/env.ts, sightengine.ts, admin varsAdmin | `parseModerationThreshold` (0,1]; fallback 0.5; non-numeric score = manual review; panel rejects bad input | T1–T3 |
| 9 | P2 | Wallet deposit notice marked delivered before sending; failures swallowed | services/wallet/walletDeposits.ts | mark after success, retry ≤10, 403/400 final | v128-wallet-notify (3) |
| 10 | P3 | Legacy brand strings in monitor page / menu button | public/monitor, scripts/set-menu-button | renamed; `migrate-brand` script | v128-brand (3) |

## Migration & rollback
* DB name (`nava`), collection names, ids, usernames: **unchanged**.
* `scripts/migrate-brand.ts` — dry-run by default; `--apply --backup file.json` (refuses without backup); CAS on exact old text; integrity checks; `--rollback file.json`. Only `content.text` is written; `bot_settings.vars` are only reported. Take `mongodump` first.
* `scripts/bg-reconcile.ts` — report only by default; `--apply` refunds only provable losses (stake ledger entry exists, game document gone, no payout ledger entry), idempotent under ledger id `gstake-back:<gid>:<uid>`.
* The old `bg_games.ttl` index is dropped automatically on first use (harmless if absent). Rolling back the code does not recreate it (it must not be recreated).
* Env changes: none required. No new env vars.

## Reviewed, no change needed / not deeply audited
Webhook secret check, cron auth (`CRON_SECRET`, constant-time compare), mini-app initData verification (HMAC + max age) were read and look sound. Rate limiting, media pipeline, sessions and webhook inbox were reviewed only at the code-reading level and not load-tested.

## Remaining risks
* Social content (posts/stories) is still visible across age bands; only contact/discovery is separated. Age is self-reported.
* Fake Mongo cannot prove real multi-document transaction rollback or real-world write atomicity; staging verification with a real replica set is recommended before production.
* Nothing was verified on real Telegram clients / devices (UI checks used Playwright touch emulation only).
* Guest cards show fictional members (by design).
