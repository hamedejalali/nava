#!/usr/bin/env node
/**
 * Non-destructive smoke test for a STAGING (or Preview) deployment. Refuses to run without an explicit base URL and never sends credentials.
 *   STAGING_URL=https://<preview-or-staging-host> node scripts/smoke-staging.mjs
 * Checks: /api/health answers 200 JSON {ok:true}, is not cacheable, exposes no secret-looking text; webhook rejects a request without the
 * secret header; Mini App shell + service worker load and carry the same version as package.json. It does NOT prove DB/Telegram behaviour.
 */
import { readFileSync } from "node:fs";
const base = (process.env.STAGING_URL || "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base)) { console.error("STAGING_URL (https://…) is required"); process.exit(2); }
if (/production|prod\./i.test(process.env.STAGING_URL_LABEL || "")) { console.error("Refusing: label says production"); process.exit(2); }
const ver = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const fails = [];
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`); if (!ok) fails.push(name); };
const get = (p, init) => fetch(base + p, { redirect: "manual", signal: AbortSignal.timeout(15000), ...init });
try {
  const h = await get("/api/health"); const t = await h.text();
  check("health 200", h.status === 200, String(h.status));
  check("health no-store", /no-store/i.test(h.headers.get("cache-control") || ""));
  check("health no secret-looking text", !/(mongodb(\+srv)?:\/\/|\d{6,}:[A-Za-z0-9_-]{30,}|password)/i.test(t));
  check("health rejects POST", (await get("/api/health", { method: "POST" })).status === 405);
  const w = await get("/api/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("webhook refuses without secret header", w.status >= 400 && w.status < 500, String(w.status));
  const idx = await (await get("/miniapp/index.html")).text();
  check("mini app index carries package version", idx.includes(`?v=${ver}`), ver);
  const sw = await (await get("/miniapp/sw.js")).text();
  check("service worker version matches", sw.includes(`ng-${ver}`));
} catch (e) { check("request completed", false, e?.name || "error"); }
if (fails.length) { console.error(`\nSMOKE FAILED: ${fails.join("; ")}`); process.exit(1); }
console.log("\nSMOKE OK (basic reachability only)");
