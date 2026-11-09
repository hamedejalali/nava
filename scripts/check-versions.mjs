#!/usr/bin/env node
/**
 * Version + lock-file consistency (v1.29.6). Exit code 1 on ANY mismatch. Read-only.
 *   node scripts/check-versions.mjs
 * Compares: package.json, package-lock.json (top-level AND root package), src/config/version.ts, newest CHANGELOG.md entry,
 * public/miniapp core.js / sw.js / index.html (every ?v=), and that the lock's root dependency ranges equal package.json's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const want = pkg.version;
const errors = [];
const expect = (what, got) => { if (got !== want) errors.push(`${what}: ${got ?? "(missing)"} ≠ package.json ${want}`); };

expect("package-lock.json version", lock.version);
expect("package-lock.json packages[''].version", lock.packages?.[""]?.version);
expect("src/config/version.ts BOT_VERSION", read("src/config/version.ts").match(/BOT_VERSION\s*=\s*"([^"]+)"/)?.[1]);
expect("CHANGELOG.md newest entry", read("CHANGELOG.md").match(/^## v(\d+\.\d+\.\d+)/m)?.[1]);
expect("public/miniapp/core.js NG.VER", read("public/miniapp/core.js").match(/NG\.VER\s*=\s*"([^"]+)"/)?.[1]);
expect("public/miniapp/sw.js VERSION", read("public/miniapp/sw.js").match(/VERSION\s*=\s*"ng-([^"]+)"/)?.[1]);
const html = read("public/miniapp/index.html");
const vs = [...html.matchAll(/\?v=([0-9.]+)/g)].map((m) => m[1]);
if (!vs.length) errors.push("public/miniapp/index.html: no ?v= found");
for (const v of new Set(vs)) expect("public/miniapp/index.html ?v=", v);
for (const m of read("public/miniapp/core.js").matchAll(/\?v=(\d+\.\d+\.\d+)/g)) expect("public/miniapp/core.js ?v=", m[1]);

for (const kind of ["dependencies", "devDependencies"]) {
  const a = JSON.stringify(Object.entries(pkg[kind] ?? {}).sort());
  const b = JSON.stringify(Object.entries(lock.packages?.[""]?.[kind] ?? {}).sort());
  if (a !== b) errors.push(`package-lock.json root ${kind} differ from package.json`);
}
if (errors.length) { console.error("VERSION / LOCK CHECK FAILED:\n - " + errors.join("\n - ")); process.exit(1); }
console.log(`versions consistent: ${want} (package.json, package-lock.json ×2, version.ts, CHANGELOG, core.js, sw.js, index.html ×${vs.length}, lock root dependencies)`);
