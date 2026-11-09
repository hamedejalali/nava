# Release process (v1.29.6)

Gate: `npm run verify` locally and `npm run verify:ci` (real `npm ci` + prod `npm audit --audit-level=high`) in any CI. Every step is required; the first failure exits non-zero. Provider-neutral: any CI that can run Node ≥ 18.18 and `npm run verify:ci` works (a GitHub Actions job is just checkout → setup-node → `npm run verify:ci`).
The tests use fake MongoDB/Telegram — a green gate does not prove real infrastructure behaviour.

## Recommended path (Preview → verify → promote)
1. Build from the tagged commit. Deploy as a **Preview** (not Production) with STAGING env — see `docs/STAGING.md`.
2. Run `npm run smoke:staging` against it and the manual checks.
3. Only then promote that same deployment to Production (Vercel "Promote"), so the artifact that was tested is the one that runs.
4. Watch `/monitor` (new cards: cron freshness, job backlog, API latency/errors, RUM) and Vercel runtime logs for 30–60 minutes.
5. Rollback: Vercel → Deployments → previous deployment → "Promote to Production" (instant, no rebuild). Rolling back code does NOT roll back data; additive fields (`cbId`, `ops_metrics`, `monitor_state`) are ignored by old code, so a code rollback is safe.

## Canary
Weighted canary / rolling release: **NOT VERIFIED** — the engineer cannot confirm the project's plan or feature availability. Use the Preview→verify→promote path above. If the owner enables Vercel Rolling Releases, keep the monitoring thresholds in `docs/MONITORING.md` as abort criteria.

## Never
Run migrations, restores or `reconcile` with write intent against production from CI; deploy on a failing gate; change production env vars as part of a code release without a separate note.
