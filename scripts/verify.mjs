#!/usr/bin/env node
/**
 * One reproducible release gate (v1.29.6):  npm run verify
 *
 *   1. versions + lock-file consistency      (scripts/check-versions.mjs)
 *   2. static secret scan                    (scripts/check-secrets.mjs)
 *   3. Mini App static checks                (scripts/check-miniapp.mjs)
 *   4. dependency install consistency        `npm ci --dry-run` (the lock must satisfy package.json) — or a REAL `npm ci` with --install
 *   5. TypeScript                            npm run typecheck
 *   6. full test suite                       npm test
 *   7. production build                      npm run build
 *   8. (--audit) production dependency advisories, high or above   npm audit --omit=dev --audit-level=high
 *
 * Every step is REQUIRED: the first failure stops the run and the process exits non-zero, so a pipeline can never report success
 * after a failed check. Nothing here touches the network (except --install / --audit), a database, Telegram or Vercel.
 * The tests use fake MongoDB / Telegram: a green run is NOT proof of real infrastructure behaviour (see docs/RELEASE_PROCESS.md).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const steps = [
  ["versions + lock consistency", process.execPath, ["scripts/check-versions.mjs"]],
  ["secret scan", process.execPath, ["scripts/check-secrets.mjs"]],
  ["mini app static checks", process.execPath, ["scripts/check-miniapp.mjs"]],
  args.has("--install") ? ["npm ci (real install)", npm, ["ci", "--no-audit", "--no-fund"]] : ["npm ci --dry-run (lock satisfies package.json)", npm, ["ci", "--dry-run", "--no-audit", "--no-fund"]],
  ["typecheck", npm, ["run", "typecheck"]],
  ["tests", npm, ["test"]],
  ["build", npm, ["run", "build"]],
  ...(args.has("--audit") ? [["npm audit (production, high+)", npm, ["audit", "--omit=dev", "--audit-level=high"]]] : []),
];
const results = [];
for (const [name, cmd, a] of steps) {
  const t0 = Date.now();
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(`${r.status === 0 ? "PASS" : "FAIL"}  ${name} (${secs}s)`);
  if (r.status !== 0) {
    console.error(`\n${results.join("\n")}\n\nVERIFY FAILED at: ${name}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\n${results.join("\n")}\n\nVERIFY OK (${steps.length} required checks passed${args.has("--audit") ? "" : "; advisories not checked — add --audit"})`);
