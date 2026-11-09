# CI
Single entry point: `npm run verify:ci` (versions+lock, secret scan, mini-app static checks, `npm ci`, typecheck, tests, build, `npm audit --omit=dev --audit-level=high`). Provider-neutral; no workflow file is shipped because the hosting/CI provider is the owner's choice. Remaining known advisories: see `docs/AUDIT_v1.29.6.md` (exceljs→uuid, moderate).
