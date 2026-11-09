# Monitoring (v1.29.6)

Dashboard: `/monitor` (admin-secret protected, unchanged). New in 1.29.6 (`src/services/monitorOps.ts`, all additive, privacy-preserving):
| Signal | Source | Alert rule |
|---|---|---|
| Cron freshness | heartbeat written by `api/cron/*` after the secret check | no heartbeat for 36 h per cron |
| Job backlog | capped count (`limit` + `maxTimeMS`) of pending broadcast/jeton jobs | > 20 |
| Payments | stuck pending payments (capped count) | any older than threshold |
| API latency/errors | `api/miniapp.ts` wrapper (POST only, via `waitUntil`) in sharded `ops_metrics` buckets | avg > 2500 ms or error rate high |
| RUM | mini app `rum` action; sanitized (whitelisted numeric fields, no ids, no URLs) | shown, no alert |
Alerts: per-condition cooldown and a storm cap of 3 alerts per run, so an outage cannot flood the owner. Alert texts contain no secrets, ids or raw errors. `/api/health` is public, `no-store`, GET/HEAD only and returns only booleans/timings.
`CRON_SECRET` missing raises a `cron_secret_missing` alert. Logs use codes from `docs/ERROR_CODES.md`.
Limit: all of this is exercised with mock tests only; verify on staging.
