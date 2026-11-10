import type { Db } from "mongodb";
import { getDb } from "../db/connect.js";

/**
 * v1.29.6 — operational signals added to the monitoring snapshot (OWNER / ADMIN only; nothing here is public).
 *
 *  - cron heartbeats + whether CRON_SECRET is configured,
 *  - durable-job backlog and stale leases (match deliveries, search notices, broadcast / jeton jobs),
 *  - failed / unmatched payment & wallet records (counts only),
 *  - Mini App API request / error / latency buckets (sharded to avoid one hot document),
 *  - real-user performance samples from the Mini App (numbers only: no user id, no IP, no URL, no content).
 *
 * Truthfulness: every figure is a count read from MongoDB; a source that can not be read is `{available:false}`.
 * All counts are capped (limit + maxTimeMS) so the monitoring query can never become the load it is watching.
 * Nothing here reads message text, profile data or any personal field.
 */

export type Metric<T> = { available: true; value: T } | { available: false; reason: string };
const ok = <T>(value: T): Metric<T> => ({ available: true, value });
const na = (reason: string): Metric<never> => ({ available: false, reason });

const COUNT_CAP = 1000;
const COUNT_OPTS = { limit: COUNT_CAP, maxTimeMS: 2000 } as const;

/* ------------------------------------------------------------------ cron heartbeats */
/** expected gap between two successful runs (vercel.json: both daily on the Hobby plan) + slack */
export const CRON_EXPECTED_MS: Record<string, number> = {
  "expire-searches": 36 * 3600_000,
  "process-broadcasts": 36 * 3600_000,
};

/** Never throws. Called by a cron endpoint AFTER it passed the secret check (so a heartbeat proves the secret works). */
export async function recordCronRun(name: string, now = new Date()): Promise<void> {
  try {
    if (!(name in CRON_EXPECTED_MS)) return;
    const db = await getDb();
    await db.collection<any>("monitor_state").updateOne({ _id: `cron:${name}` } as any, { $set: { at: now } }, { upsert: true });
  } catch { /* monitoring must never break the job */ }
}

/* ------------------------------------------------------------------ API + RUM buckets */
const API_SHARDS = 4;
const RUM_TTL_MS = 14 * 24 * 3600_000;
const API_TTL_MS = 48 * 3600_000;

/** Never throws. One upsert per Mini App POST, spread over a few documents per minute. */
export async function recordApiMetric(isError: boolean, ms: number, now = new Date(), shard = Math.floor(Math.random() * API_SHARDS)): Promise<void> {
  try {
    const db = await getDb();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const dur = Math.max(0, Math.min(600_000, Math.round(ms)));
    await db.collection<any>("ops_metrics").updateOne(
      { _id: `api:${minute.toISOString().slice(0, 16)}:${shard}` } as any,
      { $inc: { requests: 1, errors: isError ? 1 : 0, latencySumMs: dur, ...(dur >= 1000 ? { slow: 1 } : {}) }, $max: { latencyMaxMs: dur }, $setOnInsert: { kind: "api", minute, expiresAt: new Date(now.getTime() + API_TTL_MS) } },
      { upsert: true },
    );
  } catch { /* never breaks a request */ }
}

export interface RumSample { loadMs: number; apiMs: number | null; net: "4g" | "3g" | "2g" | "slow-2g" | "unknown" }
const RUM_BINS = [1000, 2000, 4000, 8000]; // upper edges of bins 0..3; bin 4 = slower

/** Validates untrusted client input; returns null when it is not a usable sample. Numbers and one enum only. */
export function sanitizeRum(body: Record<string, unknown>): RumSample | null {
  const n = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
  const loadMs = n(body.loadMs, 120_000);
  if (loadMs === null) return null;
  const apiMs = n(body.apiMs, 120_000);
  const netRaw = typeof body.net === "string" ? body.net : "";
  const net = (["4g", "3g", "2g", "slow-2g"] as const).find((x) => x === netRaw) ?? "unknown";
  return { loadMs, apiMs, net };
}

/** Never throws. Hourly bucket; the client sends at most one sample per Mini App session. */
export async function recordRumSample(s: RumSample, now = new Date()): Promise<void> {
  try {
    const db = await getDb();
    const hour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
    const bin = RUM_BINS.findIndex((e) => s.loadMs < e);
    const inc: Record<string, number> = { samples: 1, loadSumMs: s.loadMs, [`l${bin === -1 ? RUM_BINS.length : bin}`]: 1, [`net_${s.net.replace("-", "_")}`]: 1 };
    if (s.apiMs !== null) { inc.apiN = 1; inc.apiSumMs = s.apiMs; }
    await db.collection<any>("ops_metrics").updateOne(
      { _id: `rum:${hour.toISOString().slice(0, 13)}` } as any,
      { $inc: inc, $setOnInsert: { kind: "rum", minute: hour, expiresAt: new Date(now.getTime() + RUM_TTL_MS) } },
      { upsert: true },
    );
  } catch { /* never breaks a request */ }
}

/* ------------------------------------------------------------------ snapshot part */
export interface OpsSnapshot {
  cron: { secretConfigured: boolean; lastRun: Record<string, string | null> };
  jobs: Metric<{
    matchDeliveriesOverdue: number; matchDeliveriesStaleLease: number; searchNoticesOverdue: number; searchNoticesStaleLease: number;
    broadcastJobsStale: number; jetonJobsStale: number; capped: boolean;
  }>;
  payments: Metric<{ starsExceptions24h: number; walletUnmatched: number; walletUnnotifiedOver15min: number; walletSyncFailing: boolean; walletSyncError: string | null; capped: boolean }>;
  api: Metric<{ last5min: ApiWindow; last60min: ApiWindow }>;
  rum: Metric<{ last24h: RumWindow }>;
}
export interface ApiWindow { requests: number; errors: number; errorRatePct: number | null; avgLatencyMs: number | null; maxLatencyMs: number | null; slowOver1s: number }
export interface RumWindow { samples: number; avgLoadMs: number | null; shareOver4sPct: number | null; avgFirstApiMs: number | null; slowNetworkSharePct: number | null }

function apiWindow(rows: any[]): ApiWindow {
  const requests = rows.reduce((a, r) => a + (r.requests ?? 0), 0);
  const errors = rows.reduce((a, r) => a + (r.errors ?? 0), 0);
  const lat = rows.reduce((a, r) => a + (r.latencySumMs ?? 0), 0);
  return {
    requests, errors,
    errorRatePct: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : null,
    avgLatencyMs: requests > 0 ? Math.round(lat / requests) : null,
    maxLatencyMs: rows.length ? Math.max(...rows.map((r) => r.latencyMaxMs ?? 0)) : null,
    slowOver1s: rows.reduce((a, r) => a + (r.slow ?? 0), 0),
  };
}
function rumWindow(rows: any[]): RumWindow {
  const samples = rows.reduce((a, r) => a + (r.samples ?? 0), 0);
  const sum = (k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const apiN = sum("apiN");
  const slowNet = sum("net_3g") + sum("net_2g") + sum("net_slow_2g");
  return {
    samples,
    avgLoadMs: samples ? Math.round(sum("loadSumMs") / samples) : null,
    shareOver4sPct: samples ? Math.round(((sum("l3") + sum("l4")) / samples) * 1000) / 10 : null,
    avgFirstApiMs: apiN ? Math.round(sum("apiSumMs") / apiN) : null,
    slowNetworkSharePct: samples ? Math.round((slowNet / samples) * 1000) / 10 : null,
  };
}

async function count(db: Db, name: string, filter: Record<string, unknown>): Promise<number> {
  return db.collection(name).countDocuments(filter as any, COUNT_OPTS as any);
}

export async function collectOps(now: Date, env: { CRON_SECRET?: string } = process.env as any): Promise<OpsSnapshot> {
  const db = await getDb();
  const t = (ms: number) => new Date(now.getTime() - ms);
  const min = 60_000;

  const cron = await (async () => {
    const lastRun: Record<string, string | null> = {};
    for (const name of Object.keys(CRON_EXPECTED_MS)) {
      try { const d: any = await db.collection<any>("monitor_state").findOne({ _id: `cron:${name}` } as any); lastRun[name] = d?.at ? new Date(d.at).toISOString() : null; }
      catch { lastRun[name] = null; }
    }
    return { secretConfigured: !!env.CRON_SECRET, lastRun };
  })();

  const jobs = await (async (): Promise<OpsSnapshot["jobs"]> => {
    try {
      const [a, b, c, d, e, f] = await Promise.all([
        count(db, "match_deliveries", { state: "pending", nextAttemptAt: { $lte: t(15 * min) } }),
        count(db, "match_deliveries", { state: "pending", leaseUntil: { $lt: t(5 * min) } }),
        count(db, "search_notices", { state: "armed", dueAt: { $lte: t(15 * min) } }),
        count(db, "search_notices", { state: "sending", leaseUntil: { $lt: t(5 * min) } }),
        count(db, "broadcast_jobs", { done: false, leaseUntil: { $lt: t(10 * min) } }),
        count(db, "jeton_jobs", { done: false, leaseUntil: { $lt: t(10 * min) } }),
      ]);
      return ok({ matchDeliveriesOverdue: a, matchDeliveriesStaleLease: b, searchNoticesOverdue: c, searchNoticesStaleLease: d, broadcastJobsStale: e, jetonJobsStale: f, capped: [a, b, c, d, e, f].some((x) => x >= COUNT_CAP) });
    } catch { return na("job counters unreadable"); }
  })();

  const payments = await (async (): Promise<OpsSnapshot["payments"]> => {
    try {
      const [ex, um, un, sync] = await Promise.all([
        count(db, "stars_payment_exceptions", { createdAt: { $gte: t(24 * 60 * min) } }),
        count(db, "wallet_unmatched", {}),
        count(db, "wallet_deposits", { notifiedAt: { $exists: false }, creditedAt: { $lte: t(15 * min) } }),
        db.collection<any>("wallet_sync").findOne({ _id: "cursor" } as any),
      ]);
      // v1.29.7: a lone timeout is normal (the next run just asks again) — alert only after 3 failed runs in a row, the last one recent,
      // and no successful run in the last 30 minutes.
      const failing = !!(
        sync?.lastErrorAt && (sync.errorStreak ?? 1) >= 3 &&
        (!sync.lastOkAt || new Date(sync.lastErrorAt) > new Date(sync.lastOkAt)) &&
        new Date(sync.lastErrorAt) >= t(6 * 60 * min) && (!sync.lastOkAt || new Date(sync.lastOkAt) < t(30 * min))
      );
      const walletSyncError = failing && typeof sync?.lastError === "string" ? String(sync.lastError).slice(0, 64) : null;
      return ok({ starsExceptions24h: ex, walletUnmatched: um, walletUnnotifiedOver15min: un, walletSyncFailing: failing, walletSyncError, capped: [ex, um, un].some((x) => x >= COUNT_CAP) });
    } catch { return na("payment counters unreadable"); }
  })();

  let api: OpsSnapshot["api"]; let rum: OpsSnapshot["rum"];
  try {
    const rows: any[] = await db.collection<any>("ops_metrics").find({ kind: { $in: ["api", "rum"] }, minute: { $gte: t(24 * 60 * min) } }).toArray();
    const apiRows = rows.filter((r) => r.kind === "api");
    const rumRows = rows.filter((r) => r.kind === "rum");
    api = ok({ last5min: apiWindow(apiRows.filter((r) => r.minute.getTime() >= now.getTime() - 5 * min)), last60min: apiWindow(apiRows.filter((r) => r.minute.getTime() >= now.getTime() - 60 * min)) });
    rum = ok({ last24h: rumWindow(rumRows) });
  } catch { api = na("api metrics unreadable"); rum = na("rum metrics unreadable"); }

  return { cron, jobs, payments, api, rum };
}

/* ------------------------------------------------------------------ alert conditions */
export interface OpsThresholds { jobBacklog: number; apiErrorRatePct: number; apiMinRequests: number; apiAvgLatencyMs: number }
export interface OpsCondition { key: string; text: string; cooldownMs: number }

/** Long cooldowns for conditions that do not change minute to minute (a missing secret is the same problem tomorrow): no notification storms. */
/** Plain-Persian explanation of a failing wallet sync: what it means, what it affects, what to do. */
export function walletSyncText(code: string | null): string {
  const c = (code ?? "").toUpperCase();
  let why: string; let fix: string;
  if (c === "NETWORK") { why = "سرور ولت چند بار پشت‌سرهم جواب نداد (timeout یا قطعی شبکه)."; fix = "معمولاً خودش درست می‌شود. اگر بیشتر از یک ساعت ماند، وضعیت سرویس ولت را چک کن."; }
  else if (c.includes("401") || c.includes("UNAUTH") || c.includes("403") || c.includes("FORBID") || c.includes("SIGNATURE")) { why = "ولت اطلاعات اتصال ربات را قبول نمی‌کند (احراز هویت رد شد)."; fix = "در Vercel مقدارهای WALLET_INTEGRATION_ID و WALLET_API_SECRET را با پنل ولت مقایسه کن."; }
  else if (c.includes("429")) { why = "ولت به‌خاطر تعداد زیاد درخواست موقتاً ربات را محدود کرده است."; fix = "معمولاً بعد از چند دقیقه خودش درست می‌شود."; }
  else if (/HTTP_5\d\d/.test(c)) { why = "سرور ولت خطای داخلی داده است."; fix = "مشکل از سمت ولت است؛ بعداً دوباره بررسی می‌شود."; }
  else if (c === "BAD_RESPONSE") { why = "جواب ولت قابل فهم نبود (فرمت غیرمنتظره)."; fix = "اگر ادامه پیدا کرد، آدرس/نسخه‌ی API ولت را چک کن."; }
  else { why = `ولت خطای نامشخص داد${code ? ` (کد: ${code})` : ""}.`; fix = "لاگ‌های Vercel را ببین."; }
  return `🔴 دریافت خودکار واریزهای ولت چند بار پشت‌سرهم ناموفق بود.\nعلت: ${why}\nاثر: واریز جدید کاربران فعلاً خودکار به حسابشان اضافه نمی‌شود. چیزی گم نمی‌شود و بعد از رفع مشکل همه‌ی واریزها خودکار ثبت می‌شوند.\nکار لازم: ${fix}`;
}

export function evaluateOps(o: OpsSnapshot, th: OpsThresholds, now: Date): OpsCondition[] {
  const out: OpsCondition[] = [];
  const DAY = 24 * 3600_000;
  if (!o.cron.secretConfigured) out.push({ key: "cron_secret_missing", cooldownMs: DAY, text: "🔴 CRON_SECRET تنظیم نشده؛ کران‌ها (انقضای جستجو، ارسال همگانی، تلاش مجدد اعلان‌ها) اجرا نمی‌شوند." });
  for (const [name, last] of Object.entries(o.cron.lastRun)) {
    if (!o.cron.secretConfigured || !last) continue; // never ran = a new deployment, not an outage
    if (now.getTime() - new Date(last).getTime() > (CRON_EXPECTED_MS[name] ?? 36 * 3600_000))
      out.push({ key: `cron_stale:${name}`, cooldownMs: 12 * 3600_000, text: `🟠 کران «${name}» بیش از زمان انتظار اجرا نشده (آخرین اجرا: ${last}).` });
  }
  if (o.jobs.available) {
    const j = o.jobs.value;
    const backlog = j.matchDeliveriesOverdue + j.searchNoticesOverdue;
    const stale = j.matchDeliveriesStaleLease + j.searchNoticesStaleLease + j.broadcastJobsStale + j.jetonJobsStale;
    if (backlog >= th.jobBacklog) out.push({ key: "job_backlog", cooldownMs: 6 * 3600_000, text: `🟠 صف کارهای ماندگار عقب است: ${backlog}${j.capped ? "+" : ""} مورد دیرکرده (آستانه ${th.jobBacklog}).` });
    if (stale > 0) out.push({ key: "stale_leases", cooldownMs: 6 * 3600_000, text: `🟠 ${stale} کار با lease منقضی‌شده و ناتمام وجود دارد (کارگر وسط کار متوقف شده).` });
  }
  if (o.payments.available) {
    const p = o.payments.value;
    if (p.starsExceptions24h > 0) out.push({ key: "stars_exceptions", cooldownMs: 6 * 3600_000, text: `🔴 ${p.starsExceptions24h} پرداخت Stars با خطا/عدم‌تطابق در ۲۴ ساعت اخیر (نیاز به بررسی دستی).` });
    if (p.walletUnmatched > 0) out.push({ key: "wallet_unmatched", cooldownMs: 12 * 3600_000, text: `🔴 ${p.walletUnmatched} واریز کیف پول بدون تطبیق (نیاز به بررسی دستی).` });
    if (p.walletUnnotifiedOver15min > 0) out.push({ key: "wallet_unnotified", cooldownMs: 6 * 3600_000, text: `🟠 ${p.walletUnnotifiedOver15min} واریز اعتبار شده ولی اعلان رسید به کاربر نرسیده.` });
    if (p.walletSyncFailing) out.push({ key: "wallet_sync", cooldownMs: 6 * 3600_000, text: walletSyncText(p.walletSyncError) });
  }
  if (o.api.available) {
    const w = o.api.value.last5min;
    if (w.requests >= th.apiMinRequests && w.errorRatePct !== null && w.errorRatePct >= th.apiErrorRatePct)
      out.push({ key: "api_error_rate", cooldownMs: 30 * 60_000, text: `🔴 نرخ خطای API مینی‌اپ ${w.errorRatePct}٪ در ۵ دقیقه اخیر (${w.errors}/${w.requests}).` });
    if (w.requests >= th.apiMinRequests && w.avgLatencyMs !== null && w.avgLatencyMs >= th.apiAvgLatencyMs)
      out.push({ key: "api_slow", cooldownMs: 30 * 60_000, text: `🟠 میانگین تأخیر API مینی‌اپ ${w.avgLatencyMs}ms در ۵ دقیقه اخیر (آستانه ${th.apiAvgLatencyMs}ms).` });
  }
  return out;
}
