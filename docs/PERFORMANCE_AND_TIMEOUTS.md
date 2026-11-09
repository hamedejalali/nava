# Timeouts and performance notes (v1.29.6)
- External fetches: `fetchWithTimeout` (default 20 s; backup upload 60 s). Telegram API client timeouts: bot 25 s, mini app 15 s, cron 25 s (webhook `maxDuration` is 60 s; grammY default was 500 s).
- Leases (anon pending link, inbox) are 90 s > 60 s `maxDuration` (tests enforce it).
- User media: `private` caching for revocable media instead of 1-year shared `s-maxage`.
- Mini App: lazy `<img>`; RUM beacons.
- Not changed without evidence: search/explore queries (use `npm run explain-queries` on staging), code splitting, WebP/AVIF conversion, CDN, Redis, OpenTelemetry, SSR/SSG. See the 31-item table in `docs/AUDIT_v1.29.6.md`.
