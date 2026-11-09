/** v1.29.6 — safe logging (F-03/F-15), bounded external calls, media cache policy (F-06 partial), health hardening, ops monitoring + RUM.
 *  MOCK TESTS where MongoDB / Telegram are involved (fake harness): they prove application logic only, not real Atlas / Telegram / Vercel behaviour. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ NAVA_MINIAPP_URL: "https://nava.example.com", BOT_USERNAME: "NavaTestBot" });
const { default: miniapp } = await import("../../api/miniapp.js");
const { default: health } = await import("../../api/health.js");
const { default: expireCron } = await import("../../api/cron/expire-searches.js");
const { errInfo, logError, ERROR_CODES } = await import("../../src/utils/safeLog.js");
const { fetchWithTimeout } = await import("../../src/utils/fetchTimeout.js");
const { storeMedia, signMedia, userMediaCacheControl } = await import("../../src/services/nava/media.js");
const Ops = await import("../../src/services/monitorOps.js");
const M = await import("../../src/services/monitor.js");
void h;

beforeEach(() => resetState());
const ROOT = new URL("../../", import.meta.url).pathname;
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p); }
  return out;
}

/* ------------------------------------------------------------------ safe logging */
test("P1. errInfo never contains the message, stack, payload or cause", () => {
  const secret = "123456:SECRET-TOKEN user-private-text";
  const e: any = new Error(secret); e.name = "GrammyError"; e.error_code = 403; e.params = { text: secret }; e.cause = new Error(secret);
  assert.equal(errInfo(e), "GrammyError[403]");
  assert.equal(errInfo(Object.assign(new Error(secret), { code: "ECONNRESET" })), "Error[ECONNRESET]");
  assert.equal(errInfo(Object.assign(new Error("x"), { name: "bad name with spaces and " + secret })), "Error");
  assert.equal(errInfo(undefined), "unknown");
  assert.equal(errInfo("string with " + secret), "non-error");
});

test("P2. logError prints one line: stable code + static description + class name only", () => {
  const lines: string[] = [];
  const orig = console.error; console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const e: any = new Error("mongodb" + "+srv://user:PASSWORD@cluster0.example.mongodb.net"); e.name = "MongoServerSelectionError";
    logError("MG-DB-001", "MongoDB connection attempt failed", e);
  } finally { console.error = orig; }
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "[MG-DB-001] MongoDB connection attempt failed :: MongoServerSelectionError");
  assert.equal(lines[0]!.includes("PASSWORD"), false);
});

test("P3. no source file logs a raw error object any more; every code is unique and documented", () => {
  const offenders: string[] = [];
  for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "api"))]) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (/console\.(error|warn)\(.*[,(] ?(err|e|error)\)\s*;?\s*$/.test(l)) offenders.push(`${f.replace(ROOT, "")}:${i + 1}`); });
  }
  assert.deepEqual(offenders, [], "raw error objects must go through logError()");
  const doc = readFileSync(join(ROOT, "docs/ERROR_CODES.md"), "utf8");
  for (const code of Object.keys(ERROR_CODES)) assert.ok(doc.includes(code), `${code} missing in docs/ERROR_CODES.md`);
});

/* ------------------------------------------------------------------ bounded external calls */
test("P4. fetchWithTimeout aborts a server that never answers", async () => {
  const srv = createServer(() => { /* never respond */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  const t0 = Date.now();
  await assert.rejects(() => fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 150));
  assert.ok(Date.now() - t0 < 3000);
  srv.closeAllConnections?.(); srv.close();
});

test("P5. no un-bounded fetch() or default-timeout Telegram client is left in the source", () => {
  const bad: string[] = [];
  for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "api"))]) {
    const s = readFileSync(f, "utf8");
    s.split("\n").forEach((l, i) => {
      if (/\bfetch\(/.test(l) && !/fetchWithTimeout|AbortSignal\.timeout|fetchImpl|=> fetch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !f.endsWith("fetchTimeout.ts")) bad.push(`${f.replace(ROOT, "")}:${i + 1} ${l.trim().slice(0, 80)}`);
      if (/new (Api|Bot<?[A-Za-z]*>?)\(env\.BOT_TOKEN\)/.test(l)) bad.push(`${f.replace(ROOT, "")}:${i + 1} default Telegram timeout`);
    });
  }
  assert.deepEqual(bad, []);
});

test("P6. MongoDB client options: bounded waits, pool size NOT raised", () => {
  const s = readFileSync(join(ROOT, "src/db/connect.ts"), "utf8");
  for (const k of ["maxPoolSize: 10", "serverSelectionTimeoutMS: 8000", "connectTimeoutMS: 10_000", "waitQueueTimeoutMS: 10_000", "maxIdleTimeMS: 60_000"]) assert.ok(s.includes(k), k);
  assert.equal(/socketTimeoutMS\s*:/.test(s), false, "socketTimeoutMS would abort long legitimate operations");
});

/* ------------------------------------------------------------------ media cache policy */
function getRes() {
  const headers: Record<string, string> = {}; let status = 0; let body: unknown;
  const res: any = { setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; }, status(c: number) { status = c; return res; }, end() { return res; }, send(b: unknown) { body = b; return res; }, json(b: unknown) { body = b; return res; } };
  return { res, headers, get status() { return status; }, get body() { return body; } };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

test("P7. user media is never cached by a SHARED cache (no `public` / `s-maxage`); DM photos only briefly; the signature is still required", async () => {
  for (const kind of ["post", "story", "cover", "dm"] as const) {
    const id = await storeMedia(1, kind, PNG);
    const r = getRes();
    await miniapp({ method: "GET", query: { m: id, s: signMedia(id) } } as any, r.res);
    assert.equal(r.status, 200, kind);
    const cc = r.headers["cache-control"]!;
    assert.match(cc, /^private,/, kind);
    assert.equal(/public|s-maxage/.test(cc), false, kind);
    assert.equal(cc, userMediaCacheControl(kind));
    if (kind === "dm") assert.match(cc, /max-age=3600$/);
    const bad = getRes();
    await miniapp({ method: "GET", query: { m: id, s: "0".repeat(24) } } as any, bad.res);
    assert.equal(bad.status, 403);
  }
  assert.equal(userMediaCacheControl(undefined), "private, max-age=604800, immutable");
});

test("P8. a deleted media item is a 404 at the origin (nothing is served from a shared cache any more)", async () => {
  const id = await storeMedia(1, "post", PNG);
  await col("mini_media").deleteOne({ _id: id }).catch(() => {});
  const { deleteMedia } = await import("../../src/services/nava/media.js");
  await deleteMedia([id]);
  const r = getRes();
  await miniapp({ method: "GET", query: { m: id, s: signMedia(id) } } as any, r.res);
  assert.equal(r.status, 404);
});

/* ------------------------------------------------------------------ health */
test("P9. /api/health: no-store, read-only methods, no secret / error text in the body", async () => {
  const r = getRes();
  await health({ method: "GET" } as any, r.res);
  assert.equal(r.headers["cache-control"], "no-store");
  const txt = JSON.stringify(r.body);
  assert.equal(txt.includes(process.env.BOT_TOKEN!), false);
  assert.equal(txt.includes("mongodb"), false);
  const p = getRes();
  await health({ method: "POST" } as any, p.res);
  assert.equal(p.status, 405);
});

/* ------------------------------------------------------------------ ops monitoring */
const NOW = new Date("2026-11-08T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

test("P10. collectOps counts overdue deliveries / stale leases / payment exceptions from real documents and ignores healthy ones", async () => {
  const min = 60_000;
  await col("match_deliveries").insertOne({ _id: "a", state: "pending", nextAttemptAt: ago(30 * min), attempts: 1 } as any);
  await col("match_deliveries").insertOne({ _id: "b", state: "pending", nextAttemptAt: ago(1 * min), attempts: 0 } as any); // not overdue
  await col("match_deliveries").insertOne({ _id: "c", state: "pending", nextAttemptAt: ago(1 * min), leaseUntil: ago(20 * min), attempts: 1 } as any); // stale lease
  await col("match_deliveries").insertOne({ _id: "d", state: "delivered", nextAttemptAt: ago(90 * min), attempts: 1 } as any);
  await col("search_notices").insertOne({ _id: "n1", state: "armed", dueAt: ago(40 * min) } as any);
  await col("search_notices").insertOne({ _id: "n2", state: "sending", leaseUntil: ago(10 * min) } as any);
  await col("broadcast_jobs").insertOne({ _id: "j1", done: false, leaseUntil: ago(30 * min) } as any);
  await col("broadcast_jobs").insertOne({ _id: "j2", done: true, leaseUntil: ago(300 * min) } as any);
  await col("stars_payment_exceptions").insertOne({ _id: "x", createdAt: ago(60 * min), reason: "mismatch" } as any);
  await col("stars_payment_exceptions").insertOne({ _id: "old", createdAt: ago(72 * 60 * min), reason: "mismatch" } as any);
  await col("wallet_unmatched").insertOne({ _id: "u" } as any);
  await col("wallet_deposits").insertOne({ _id: "d1", creditedAt: ago(30 * min) } as any); // credited, receipt never delivered
  await col("wallet_deposits").insertOne({ _id: "d2", creditedAt: ago(30 * min), notifiedAt: ago(29 * min) } as any);
  await col("wallet_deposits").insertOne({ _id: "d3", creditedAt: ago(2 * min) } as any); // still inside the grace period
  const o = await Ops.collectOps(NOW, { CRON_SECRET: "x" });
  assert.equal(o.jobs.available, true);
  const j = (o.jobs as any).value;
  assert.equal(j.matchDeliveriesOverdue, 1); assert.equal(j.matchDeliveriesStaleLease, 1);
  assert.equal(j.searchNoticesOverdue, 1); assert.equal(j.searchNoticesStaleLease, 1);
  assert.equal(j.broadcastJobsStale, 1); assert.equal(j.jetonJobsStale, 0);
  const p = (o.payments as any).value;
  assert.equal(p.starsExceptions24h, 1); assert.equal(p.walletUnmatched, 1); assert.equal(p.walletUnnotifiedOver15min, 1);
});

test("P11. conditions: missing CRON_SECRET, stale cron, backlog, stale leases, payments — and a never-run cron is NOT an outage", () => {
  const th = { jobBacklog: 20, apiErrorRatePct: 20, apiMinRequests: 10, apiAvgLatencyMs: 2500 };
  const base: any = { cron: { secretConfigured: true, lastRun: { "expire-searches": NOW.toISOString(), "process-broadcasts": null } }, jobs: { available: true, value: { matchDeliveriesOverdue: 0, matchDeliveriesStaleLease: 0, searchNoticesOverdue: 0, searchNoticesStaleLease: 0, broadcastJobsStale: 0, jetonJobsStale: 0, capped: false } },
    payments: { available: true, value: { starsExceptions24h: 0, walletUnmatched: 0, walletUnnotifiedOver15min: 0, walletSyncFailing: false, capped: false } }, api: { available: false, reason: "x" }, rum: { available: false, reason: "x" } };
  assert.deepEqual(Ops.evaluateOps(base, th, NOW), [], "healthy + never-run cron = silent");
  const noSecret = Ops.evaluateOps({ ...base, cron: { secretConfigured: false, lastRun: {} } }, th, NOW);
  assert.deepEqual(noSecret.map((c) => c.key), ["cron_secret_missing"]);
  assert.ok(noSecret[0]!.cooldownMs >= 24 * 3600_000, "a persistent config problem is not repeated every half hour");
  const stale = Ops.evaluateOps({ ...base, cron: { secretConfigured: true, lastRun: { "expire-searches": ago(40 * 3600_000).toISOString(), "process-broadcasts": null } } }, th, NOW);
  assert.deepEqual(stale.map((c) => c.key), ["cron_stale:expire-searches"]);
  const bad = Ops.evaluateOps({ ...base, jobs: { available: true, value: { ...base.jobs.value, matchDeliveriesOverdue: 25, broadcastJobsStale: 1 } },
    payments: { available: true, value: { starsExceptions24h: 2, walletUnmatched: 1, walletUnnotifiedOver15min: 1, walletSyncFailing: true, capped: false } },
    api: { available: true, value: { last5min: { requests: 50, errors: 20, errorRatePct: 40, avgLatencyMs: 4000, maxLatencyMs: 9000, slowOver1s: 30 }, last60min: {} } } }, th, NOW).map((c) => c.key).sort();
  assert.deepEqual(bad, ["api_error_rate", "api_slow", "job_backlog", "stale_leases", "stars_exceptions", "wallet_sync", "wallet_unmatched", "wallet_unnotified"].sort());
});

test("P12. notification-storm guard: at most 3 alerts per evaluation, each condition once per its own cooldown", async () => {
  const snap: any = await M.collectSnapshot({ now: () => NOW, getWebhookInfo: async () => ({ pending_update_count: 5000 }) });
  // force many conditions at once
  snap.database = { available: false, reason: "x" };
  snap.ops = { available: true, value: { cron: { secretConfigured: false, lastRun: {} }, jobs: { available: true, value: { matchDeliveriesOverdue: 99, matchDeliveriesStaleLease: 1, searchNoticesOverdue: 0, searchNoticesStaleLease: 0, broadcastJobsStale: 0, jetonJobsStale: 0, capped: false } },
    payments: { available: true, value: { starsExceptions24h: 1, walletUnmatched: 1, walletUnnotifiedOver15min: 1, walletSyncFailing: true, capped: false } }, api: { available: false, reason: "x" }, rum: { available: false, reason: "x" } } };
  const sentTexts: string[] = [];
  const first = await M.runAlertCheck({ now: () => NOW, send: async (t) => { sentTexts.push(t); } }, snap);
  assert.equal(first.length, 3, "capped");
  const second = await M.runAlertCheck({ now: () => new Date(NOW.getTime() + 60_000), send: async (t) => { sentTexts.push(t); } }, snap);
  assert.equal(second.length, 3, "the next evaluation picks up the remaining ones");
  assert.equal(second.some((k) => first.includes(k)), false, "nothing is repeated inside its cooldown");
  assert.equal(sentTexts.every((t) => !/mongodb(\+srv)?:\/\/|BOT_TOKEN=|:[A-Za-z0-9_-]{30,}/i.test(t)), true, "no connection string / token in alert text");
});

test("P13. the cron endpoints record a heartbeat ONLY after the secret check; a wrong secret records nothing", async () => {
  const r = getRes();
  await expireCron({ headers: { authorization: "Bearer wrong" } } as any, r.res);
  assert.equal(r.status, 401);
  assert.equal(col("monitor_state").all().some((d: any) => String(d._id).startsWith("cron:")), false);
  for (const f of ["api/cron/expire-searches.ts", "api/cron/process-broadcasts.ts"]) {
    const s = readFileSync(join(ROOT, f), "utf8");
    assert.ok(s.indexOf("recordCronRun(") > s.indexOf("Unauthorized"), f);
  }
  await Ops.recordCronRun("expire-searches", NOW);
  await Ops.recordCronRun("not-a-cron", NOW);
  assert.equal(col("monitor_state").all().filter((d: any) => String(d._id).startsWith("cron:")).length, 1, "unknown names are ignored");
});

test("P14. API metrics: sharded buckets, counts only; windows summarised; webhook metrics are not polluted", async () => {
  await Ops.recordApiMetric(false, 120, NOW, 0);
  await Ops.recordApiMetric(false, 1800, NOW, 1);
  await Ops.recordApiMetric(true, 50, NOW, 2);
  await Ops.recordApiMetric(false, 70, ago(30 * 60_000), 0);
  const rows = col("ops_metrics").all() as any[];
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.kind === "api" && r.expiresAt instanceof Date));
  assert.deepEqual(Object.keys(rows[0]).filter((k) => !["_id", "kind", "minute", "expiresAt", "requests", "errors", "latencySumMs", "latencyMaxMs", "slow"].includes(k)), [], "only counters");
  const o: any = await Ops.collectOps(new Date(NOW.getTime() + 1000), { CRON_SECRET: "x" });
  const w5 = o.api.value.last5min, w60 = o.api.value.last60min;
  assert.equal(w5.requests, 3); assert.equal(w5.errors, 1); assert.equal(w5.slowOver1s, 1); assert.equal(w5.maxLatencyMs, 1800);
  assert.equal(w60.requests, 4);
  const snap: any = await M.collectSnapshot({ now: () => new Date(NOW.getTime() + 1000), getWebhookInfo: async () => ({ pending_update_count: 0 }) });
  assert.equal(snap.traffic.last60min.value.requests, 0, "webhook traffic window ignores api/rum buckets");
});

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(userId: number, body: any) {
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, send(o: any) { payload = o; return res; }, end() { return res; } };
  await miniapp({ method: "POST", body: { initData: init(userId), ...body } } as any, res);
  return { status, payload };
}

test("P15. RUM: input is validated; one sample stores numbers only (no user id / ip / url); the handler also counts the request", async () => {
  seedUser({ id: 10, anonId: "user_RUM1", nickname: "الف", profilePhotoFileId: "F", onboardingStep: "COMPLETED", relicBalance: 5, miniUsername: "alef" } as any);
  seedUser({ id: OWNER_ID, anonId: "user_OWNR", nickname: "مویا", age: 33, onboardingStep: "COMPLETED", relicBalance: 0 } as any);
  assert.equal(Ops.sanitizeRum({ loadMs: -1 }), null);
  assert.equal(Ops.sanitizeRum({ loadMs: "5" }), null);
  assert.equal(Ops.sanitizeRum({ loadMs: 1e9 }), null);
  assert.deepEqual(Ops.sanitizeRum({ loadMs: 1234.4, apiMs: 300, net: "evil<script>" }), { loadMs: 1234, apiMs: 300, net: "unknown" });
  const bad = await call(10, { action: "rum", loadMs: "x" });
  assert.equal(bad.payload.ok, false);
  const r = await call(10, { action: "rum", loadMs: 3200, apiMs: 410, net: "3g", userId: 10, url: "https://x", ip: "1.2.3.4" });
  assert.equal(r.status, 200); assert.equal(r.payload.ok, true);
  await new Promise((x) => setTimeout(x, 30));
  const rum = (col("ops_metrics").all() as any[]).filter((d) => d.kind === "rum");
  assert.equal(rum.length, 1);
  const dump = JSON.stringify(rum[0]);
  assert.equal(/userId|"ip"|1\.2\.3\.4|https:\/\/x|user_RUM1|alef/.test(dump), false, "nothing identifying");
  assert.deepEqual(Object.keys(rum[0]).sort(), ["_id", "apiN", "apiSumMs", "expiresAt", "kind", "l2", "loadSumMs", "minute", "net_3g", "samples"]);
  assert.equal(rum[0].samples, 1); assert.equal(rum[0].l2, 1); assert.equal(rum[0].net_3g, 1); assert.equal(rum[0].apiN, 1);
  const api = (col("ops_metrics").all() as any[]).filter((d) => d.kind === "api");
  assert.ok(api.reduce((a, d) => a + d.requests, 0) >= 2, "each Mini App POST is counted");
  const o: any = await Ops.collectOps(new Date(), { CRON_SECRET: "x" });
  assert.equal(o.rum.value.last24h.samples, 1);
  assert.equal(o.rum.value.last24h.slowNetworkSharePct, 100);
});

test("P16. an unauthenticated 'rum' call stores nothing", async () => {
  let status = 0;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json() { return res; }, send() { return res; }, end() { return res; } };
  await miniapp({ method: "POST", body: { action: "rum", loadMs: 100, initData: "forged" } } as any, res);
  assert.ok(status === 401 || status === 403);
  await new Promise((x) => setTimeout(x, 30));
  assert.equal((col("ops_metrics").all() as any[]).filter((d) => d.kind === "rum").length, 0);
});

test("P99. inbox lease (processUpdate) is longer than the webhook function's maxDuration", async () => {
  const { readFileSync } = await import("node:fs");
  const { LEASE_MS } = await import("../../src/webhook/processUpdate.js");
  const cfg = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  assert.ok(LEASE_MS > cfg.functions["api/webhook.ts"].maxDuration * 1000);
});
