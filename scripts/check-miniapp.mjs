#!/usr/bin/env node
/** Mini App static checks (no browser needed): every script parses, every <script src> in index.html exists, and order keeps core.js first / main.js last. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "miniapp");
const errors = [];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
for (const f of walk(dir).filter((f) => f.endsWith(".js") && !f.includes("/vendor/"))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) errors.push(`syntax error in ${f.replace(dir + "/", "")}: ${r.stderr.split("\n")[0]}`);
}
const html = readFileSync(join(dir, "index.html"), "utf8");
const srcs = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map((m) => m[1]);
for (const s of srcs) if (!/^https?:/.test(s) && !existsSync(join(dir, s))) errors.push(`index.html references a missing file: ${s}`);
const local = srcs.filter((s) => !/^https?:/.test(s));
if (local[0] !== "core.js") errors.push(`core.js must be the first local script (got ${local[0]})`);
if (local.at(-1) !== "main.js") errors.push(`main.js must be the last local script (got ${local.at(-1)})`);
if (errors.length) { console.error("MINI APP CHECK FAILED:\n - " + errors.join("\n - ")); process.exit(1); }
console.log(`mini app: ${local.length} scripts parse, all referenced files exist, order core.js … main.js`);
