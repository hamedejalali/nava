import { env } from "../config/env.js";
import { getDb } from "../db/connect.js";
import type { UserDoc } from "../db/models/user.js";
import { verifyTelegramWebAppInitData } from "../utils/telegramWebApp.js";

/**
 * Monitoring Mini App backend (v1.9.0) — OWNER / ADMIN ONLY.
 *
 * Truthfulness rules:
 *  - Every number comes from a real source (MongoDB, Telegram, this
 *    process). If a source can't be read the field is `{available:false}`
 *    — we never invent, default to 0 or fake a "healthy" value.
 *  - "System load %" is NOT reported: on Vercel serverless there is no
 *    persistent host to measure (each invocation is an isolated container,
 *    os.loadavg() describes a shared micro-VM, not "the bot"). Instead the
 *    real load signals are exposed: requests/min, error rate, latency,
 *    Telegram pending updates, DB latency.
 */

export const MONITOR_INITDATA_MAX_AGE_SECONDS = 3600;

// ---------- thresholds (env-tunable, safe defaults) ----------
function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
export function thresholds() {
  return {
    errorRatePct: num("MONITOR_ERROR_RATE_PCT", 20),
    minRequests: num("MONITOR_MIN_REQUESTS", 10),
    dbLatencyMs: num("MONITOR_DB_LATENCY_MS", 1500),
    pendingUpdates: num("MONITOR_PENDING_UPDATES", 50),
    cooldownMs: num("MONITOR_ALERT_COOLDOWN_MIN", 30) * 60_000,
    evalIntervalMs: 60_000,
  };
}

// ---------- staff gate ----------
export type StaffResult = { ok: true; id: number } | { ok: false; status: number; error: string };

export async function authenticateStaff(initData: unknown): Promise<StaffResult> {
  if (typeof initData !== "string" || !initData || initData.length > 4096) return { ok: false, status: 401, error: "unauthorized" };
  const tg = verifyTelegramWebAppInitData(initData, env.BOT_TOKEN, MONITOR_INITDATA_MAX_AGE_SECONDS);
  if (!tg) return { ok: false, status: 401, error: "unauthorized" };
  if (env.OWNER_ID === tg.id || env.ADMIN_IDS.includes(tg.id)) return { ok: true, id: tg.id };
  const db = await getDb();
  const u = await db.collection<UserDoc>("users").findOne({ _id: tg.id }, { projection: { isAdmin: 1, banned: 1 } });
  if (u && u.isAdmin === true && !u.banned) return { ok: true, id: tg.id };
  return { ok: false, status: 403, error: "forbidden" };
}

// ---------- webhook metrics (per-minute buckets) ----------
interface MetricBucket {
  _id: string; // "YYYY-MM-DDTHH:MM" (UTC)
  minute: Date;
  requests: number;
  errors: number;
  latencySumMs: number;
  latencyMaxMs: number;
  expiresAt: Date;
}
const METRIC_TTL_MS = 48 * 3600_000;

function bucketId(d: Date): string {
  return d.toISOString().slice(0, 16);
}

let metricIndexOnce = false;
async function metricsCol() {
  const db = await getDb();
  const col = db.collection<MetricBucket>("ops_metrics");
  if (!metricIndexOnce) {
    metricIndexOnce = true;
    col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { metricIndexOnce = false; });
  }
  return col;
}

/** Never throws: monitoring must not be able to break update handling. */
export async function recordWebhookMetric(ok: boolean, ms: number, now = new Date()): Promise<void> {
  try {
    const col = await metricsCol();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const dur = Math.max(0, Math.round(ms));
    await col.updateOne(
      { _id: bucketId(now) },
      {
        $inc: { requests: 1, errors: ok ? 0 : 1, latencySumMs: dur },
        $max: { latencyMaxMs: dur },
        $setOnInsert: { minute, expiresAt: new Date(now.getTime() + METRIC_TTL_MS) },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error("[monitor] record failed:", err instanceof Error ? err.name : "unknown");
  }
}

// ---------- snapshot ----------
export type Metric<T> = { available: true; value: T } | { available: false; reason: string };
const ok = <T>(value: T): Metric<T> => ({ available: true, value });
const na = (reason: string): Metric<never> => ({ available: false, reason });

export interface WebhookInfoLite { pending_update_count: number; last_error_message?: string; last_error_date?: number }
export interface MonitorDeps {
  getWebhookInfo?: () => Promise<WebhookInfoLite>;
  now?: () => Date;
}

async function safe<T>(fn: () => Promise<T>, reason: string): Promise<Metric<T>> {
  try { return ok(await fn()); } catch { return na(reason); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface WindowStats { requests: number; errors: number; errorRatePct: number | null; avgLatencyMs: number | null; maxLatencyMs: number | null }

function summarize(rows: MetricBucket[]): WindowStats {
  const requests = rows.reduce((a, r) => a + r.requests, 0);
  const errors = rows.reduce((a, r) => a + r.errors, 0);
  const lat = rows.reduce((a, r) => a + r.latencySumMs, 0);
  return {
    requests,
    errors,
    errorRatePct: requests > 0 ? Math.round((errors / requests) * 1000) / 10 : null,
    avgLatencyMs: requests > 0 ? Math.round(lat / requests) : null,
    maxLatencyMs: rows.length ? Math.max(...rows.map((r) => r.latencyMaxMs)) : null,
  };
}

export async function collectSnapshot(deps: MonitorDeps = {}) {
  const now = (deps.now ?? (() => new Date()))();
  const db = await getDb();

  // DB live ping
  const dbPing = await (async (): Promise<Metric<{ latencyMs: number }>> => {
    const t = Date.now();
    try { await withTimeout(db.command({ ping: 1 }), 5000); return ok({ latencyMs: Date.now() - t }); }
    catch { return na("MongoDB unreachable"); }
  })();

  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);

  const [usersTotal, usersCompleted, usersBanned, activeChats, queueSize, requests24h, ledger1h, buckets] = await Promise.all([
    safe(() => db.collection("users").countDocuments({}), "query failed"),
    safe(() => db.collection("users").countDocuments({ onboardingStep: "COMPLETED" }), "query failed"),
    safe(() => db.collection("users").countDocuments({ banned: true }), "query failed"),
    safe(() => db.collection("chat_sessions").countDocuments({ active: true }), "query failed"),
    safe(() => db.collection("match_queue").countDocuments({}), "query failed"),
    safe(() => db.collection("chat_requests").countDocuments({ createdAt: { $gte: dayAgo } }), "query failed"),
    safe(() => db.collection("relic_transactions").countDocuments({ createdAt: { $gte: hourAgo } }), "query failed"),
    safe(() => db.collection<MetricBucket>("ops_metrics").find({ minute: { $gte: hourAgo } }).toArray(), "query failed"),
  ]);

  let webhook: Metric<WebhookInfoLite>;
  try {
    const fn = deps.getWebhookInfo ?? (async () => (await (await import("./miniapp.js")).botApi().getWebhookInfo()) as WebhookInfoLite);
    const info = await withTimeout(fn(), 4000);
    webhook = ok({ pending_update_count: info.pending_update_count, last_error_message: info.last_error_message, last_error_date: info.last_error_date });
  } catch {
    webhook = na("Telegram getWebhookInfo failed");
  }

  let last5: Metric<WindowStats>;
  let last60: Metric<WindowStats>;
  if (buckets.available) {
    const fiveAgo = now.getTime() - 5 * 60_000;
    last5 = ok(summarize(buckets.value.filter((b) => b.minute.getTime() >= fiveAgo)));
    last60 = ok(summarize(buckets.value));
  } else {
    last5 = last60 = na("metrics unreadable");
  }

  const mem = process.memoryUsage();
  return {
    generatedAt: now.toISOString(),
    database: dbPing,
    telegramWebhook: webhook,
    traffic: { last5min: last5, last60min: last60 },
    users: { total: usersTotal, registered: usersCompleted, banned: usersBanned },
    activity: { activeChats, searchQueue: queueSize, chatRequests24h: requests24h, ledgerEntries1h: ledger1h },
    // Deliberately unavailable — see the file header.
    systemLoadPercent: na("Not measurable on serverless; use traffic/latency/pending-updates instead"),
    thisInstance: { rssMb: Math.round(mem.rss / 1048576), uptimeSec: Math.round(process.uptime()), note: "Only the serverless container that answered this request" },
    thresholds: (({ evalIntervalMs, ...rest }) => rest)(thresholds()),
  };
}
export type Snapshot = Awaited<ReturnType<typeof collectSnapshot>>;

// ---------- alerts with persisted cooldown ----------
interface StateDoc { _id: string; at: Date }
async function stateCol() {
  return (await getDb()).collection<StateDoc>("monitor_state");
}

/** Atomic "claim": true for exactly one caller per `windowMs`, across ALL
 *  instances (state lives in MongoDB, not in memory). */
export async function claimSlot(key: string, windowMs: number, now = new Date()): Promise<boolean> {
  const col = await stateCol();
  const cutoff = new Date(now.getTime() - windowMs);
  const upd = await col.updateOne({ _id: key, at: { $lte: cutoff } }, { $set: { at: now } });
  if (upd.matchedCount === 1) return true;
  try {
    await col.insertOne({ _id: key, at: now });
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // exists and still inside the window
    throw err;
  }
}

export interface AlertCondition { key: string; text: string }

export function evaluateConditions(s: Snapshot): AlertCondition[] {
  const t = thresholds();
  const out: AlertCondition[] = [];
  if (!s.database.available) out.push({ key: "db_down", text: "🔴 MongoDB در دسترس نیست." });
  else if (s.database.value.latencyMs > t.dbLatencyMs) out.push({ key: "db_slow", text: `🟠 تأخیر دیتابیس بالاست: ${s.database.value.latencyMs}ms (آستانه ${t.dbLatencyMs}ms)` });
  if (s.traffic.last5min.available) {
    const w = s.traffic.last5min.value;
    if (w.requests >= t.minRequests && w.errorRatePct !== null && w.errorRatePct >= t.errorRatePct)
      out.push({ key: "error_rate", text: `🔴 نرخ خطای وب‌هوک ${w.errorRatePct}٪ در ۵ دقیقه اخیر (${w.errors}/${w.requests}).` });
  }
  if (s.telegramWebhook.available) {
    if (s.telegramWebhook.value.pending_update_count >= t.pendingUpdates)
      out.push({ key: "pending", text: `🟠 آپدیت‌های در صف تلگرام: ${s.telegramWebhook.value.pending_update_count} (آستانه ${t.pendingUpdates}).` });
  }
  return out;
}

export interface AlertDeps extends MonitorDeps {
  send: (text: string) => Promise<void>;
}

/** Evaluates and sends alerts. Each condition key alerts at most once per
 *  cooldown, cluster-wide. Returns the keys actually sent. */
export async function runAlertCheck(deps: AlertDeps, snapshot?: Snapshot): Promise<string[]> {
  const t = thresholds();
  const now = (deps.now ?? (() => new Date()))();
  const snap = snapshot ?? (await collectSnapshot(deps));
  const sent: string[] = [];
  for (const c of evaluateConditions(snap)) {
    if (!(await claimSlot(`alert:${c.key}`, t.cooldownMs, now))) continue;
    try { await deps.send(`🚨 هشدار مانیتورینگ نوا\n${c.text}`); sent.push(c.key); }
    catch (err) { console.error("[monitor] alert send failed:", err instanceof Error ? err.name : "unknown"); }
  }
  return sent;
}

/** Cheap, traffic-driven trigger: at most one evaluation per minute across
 *  all instances (lease in MongoDB). Never throws. */
export async function maybeRunAlertCheck(deps: AlertDeps): Promise<void> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    if (!(await claimSlot("lease:alert-eval", thresholds().evalIntervalMs, now))) return;
    await runAlertCheck(deps);
  } catch (err) {
    console.error("[monitor] alert check failed:", err instanceof Error ? err.name : "unknown");
  }
}

export async function defaultSend(text: string): Promise<void> {
  const { getRequestRecipientIds } = await import("../features/admin/constants.js");
  const { botApi } = await import("./miniapp.js");
  for (const id of await getRequestRecipientIds()) await botApi().sendMessage(id, text).catch(() => {});
}
