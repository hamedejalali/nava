#!/usr/bin/env node
/** Cheap static secret scan of the working tree (not git history): Telegram bot tokens, MongoDB URIs with credentials, private keys, committed .env files. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".vercel"]);
const rules = [
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["MongoDB URI with credentials", /mongodb(?:\+srv)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
const hits = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n); const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    const rel = relative(root, p);
    if (/^\.env(\..+)?$/.test(n) && n !== ".env.example") hits.push(`${rel}: a real .env file is in the tree`);
    if (st.size > 2_000_000 || /\.(png|jpe?g|webp|gif|zip|woff2?|mp4|webm|lottie|json\.gz)$/i.test(n)) continue;
    const txt = readFileSync(p, "utf8");
    for (const [name, re] of rules) if (re.test(txt)) hits.push(`${rel}: ${name}`);
  }
})(root);
if (hits.length) { console.error("SECRET SCAN FAILED:\n - " + hits.join("\n - ")); process.exit(1); }
console.log("secret scan: nothing found (working tree only; git history is not covered)");
