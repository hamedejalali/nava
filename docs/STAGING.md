# Staging environment (v1.29.6) — preparation guide

Status: **NOT VERIFIED** — nothing here was executed against real Vercel/MongoDB/Telegram by the engineer (no access). Owner performs it.

## Isolation checklist (all must be true before any test)
- A separate Vercel project (or a Preview deployment with its OWN env scope) — never the production project's Production env.
- A separate MongoDB Atlas cluster/database (different URI, different user, network access limited). Never point staging at the production URI.
- A separate Telegram bot (new @BotFather token) with its own `WEBHOOK_SECRET`; set its webhook only to the staging URL (`npm run set-webhook` with staging env).
- Separate secrets for everything: `BOT_TOKEN`, `WEBHOOK_SECRET`, `CRON_SECRET`, media/HMAC secret, third-party keys (use test keys or leave unset).
- Test accounts only. No production data copy unless it is anonymised by the owner first.
- Staging crons: leave default or disable; they are guarded by `CRON_SECRET`.

## Smoke tests
1. `STAGING_URL=https://<staging> npm run smoke:staging` (health, no-store, no secrets in health, POST 405, webhook without secret refused, mini app version == package version). Basic reachability only.
2. Manual: /start → onboarding → anonymous link → send/reply/read → a blocked pair cannot contact → cross-age pair cannot contact (F-09) → backgammon lobby hides cross-age hosts.
3. `MONGODB_URI=<staging> npm run explain-queries` (read-only) to collect index evidence.
4. `MONGODB_URI=<staging> npm run reconcile-ledger` (read-only) — expect 0 mismatches or a list to review; it never fixes anything.
5. Mini App on a real phone + slow network: see `docs/MOBILE_TESTING.md`.
6. Real MongoDB transactions: the atomic pending-link completion uses a transaction. Atlas replica sets support it; **exercise it on staging** (open the same link from two clients concurrently) — it is NOT VERIFIED here (tests use a fake Mongo).
