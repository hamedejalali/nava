# CI
Single entry point: `npm run verify:ci` (versions+lock, secret scan, mini-app static checks, `npm ci`, typecheck, tests, build, `npm audit --omit=dev --audit-level=high`). Provider-neutral; no workflow file is shipped because the hosting/CI provider is the owner's choice. Remaining known advisories: see `docs/AUDIT_v1.29.6.md` (exceljs→uuid, moderate).

v1.29.8: `.github/workflows/verify.yml` runs `npm run verify:ci` on every push to `main` and on pull requests (GitHub is the owner's host). It deploys nothing and needs no secrets. It does not stop Vercel from deploying a push by itself; to make it a gate, protect the branch (require the `verify` check) or deploy from a pull request first.
