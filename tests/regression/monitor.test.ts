/** Monitoring Mini App backend (v1.9.0): staff gate, truthful metrics, persisted alert cooldown. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN = "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.OWNER_ID = "900";
process.env.ADMIN_IDS = "901";
installFakeMongo();
const M = await import("../../src/services/monitor.js");

beforeEach(() => {
  resetFakeMongo();
  seedUser({ id: 10 }); seedUser({ id: 11 }); seedUser({ id: 12, isAdmin: true }); seedUser({ id: 13, isAdmin: true, banned: true });
});

function init(userId: number, opts: { token?: string; age?: number; badHash?: boolean } = {}): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000) - (opts.age ?? 0)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(opts.token ?? process.env.BOT_TOKEN!).digest();
  let hash = createHmac("sha256", secret).update(check).digest("hex");
  if (opts.badHash) hash = hash.slice(0, 63) + (hash.endsWith("0") ? "1" : "0");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("staff gate: owner, static admin, DB admin pass; normal user, banned admin, forged/expired/foreign-token fail", async () => {
  for (const id of [900, 901, 12]) assert.equal((await M.authenticateStaff(init(id))).ok, true, `id ${id}`);
  assert.deepEqual(await M.authenticateStaff(init(10)), { ok: false, status: 403, error: "forbidden" });
  assert.equal((await M.authenticateStaff(init(13))).ok, false);
  assert.equal((await M.authenticateStaff(init(900, { badHash: true }))).status, 401);
  assert.equal((await M.authenticateStaff(init(900, { token: "1:OTHER" }))).status, 401);
  assert.equal((await M.authenticateStaff(init(900, { age: 7200 }))).status, 401);
  assert.equal((await M.authenticateStaff(undefined)).status, 401);
  assert.equal((await M.authenticateStaff("")).status, 401);
});

test("HTTP endpoint: 401 / 403 / 200 and no-store", async () => {
  const { default: handler } = await import("../../api/monitor.js");
  const run = async (body: any) => {
    let status = 200, payload: any; const headers: any = {};
    const res: any = { setHeader: (k: string, v: string) => void (headers[k] = v), status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; } };
    await handler({ method: "POST", body } as any, res);
    return { status, payload, headers };
  };
  assert.equal((await run({ action: "snapshot" })).status, 401);
  assert.equal((await run({ action: "snapshot", initData: init(10) })).status, 403);
  const ok = await run({ action: "snapshot", initData: init(900) });
  // webhook info call fails offline (no network) -> must be reported unavailable, not faked
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Cache-Control"], "no-store");
  assert.equal(ok.payload.systemLoadPercent.available, false);
});

test("metrics are truthful: real counts, error rate from buckets, unavailable when a source fails", async () => {
  const now = new Date("2026-10-04T10:00:30Z");
  for (let i = 0; i < 8; i++) await M.recordWebhookMetric(true, 100, now);
  for (let i = 0; i < 2; i++) await M.recordWebhookMetric(false, 300, now);
  const snap = await M.collectSnapshot({ now: () => now, getWebhookInfo: async () => { throw new Error("net"); } });
  assert.equal(snap.users.total.available && snap.users.total.value, 4);
  assert.equal(snap.users.banned.available && snap.users.banned.value, 1);
  const w = (snap.traffic.last5min as any).value;
  assert.equal(w.requests, 10); assert.equal(w.errors, 2); assert.equal(w.errorRatePct, 20);
  assert.equal(w.avgLatencyMs, 140); assert.equal(w.maxLatencyMs, 300);
  assert.equal(snap.telegramWebhook.available, false);
  assert.equal(snap.systemLoadPercent.available, false);
  const empty = await M.collectSnapshot({ now: () => new Date("2026-10-04T15:00:00Z"), getWebhookInfo: async () => ({ pending_update_count: 3 }) });
  assert.equal((empty.traffic.last5min as any).value.requests, 0);
  assert.equal((empty.traffic.last5min as any).value.errorRatePct, null, "no traffic => no fake 0%");
  assert.equal((empty.telegramWebhook as any).value.pending_update_count, 3);
});

test("alerts: fire on real conditions only, cooldown is persisted in Mongo and claimed atomically", async () => {
  const t0 = new Date("2026-10-04T10:00:30Z");
  for (let i = 0; i < 10; i++) await M.recordWebhookMetric(false, 50, t0);
  const sent: string[] = [];
  const deps = (now: Date) => ({ now: () => now, getWebhookInfo: async () => ({ pending_update_count: 500 }), send: async (t: string) => void sent.push(t) });

  assert.deepEqual((await M.runAlertCheck(deps(t0))).sort(), ["error_rate", "pending"]);
  assert.equal(sent.length, 2);
  // inside cooldown (even from a "new instance": state is in Mongo) -> nothing
  assert.deepEqual(await M.runAlertCheck(deps(new Date(t0.getTime() + 10 * 60_000))), []);
  assert.ok(col("monitor_state").byId("alert:error_rate"));
  // after cooldown -> alerts again
  const later = new Date(t0.getTime() + 31 * 60_000);
  await M.recordWebhookMetric(false, 50, later); // keep window populated
  const again = await M.runAlertCheck({ ...deps(later), getWebhookInfo: async () => ({ pending_update_count: 0 }) });
  assert.deepEqual(again, [], "pending recovered; error window no longer has enough requests");
});

test("alerts: concurrent evaluators send exactly once; healthy system sends nothing; low traffic does not alert", async () => {
  const now = new Date("2026-10-04T10:00:30Z");
  for (let i = 0; i < 12; i++) await M.recordWebhookMetric(false, 50, now);
  let n = 0;
  const d = { now: () => now, getWebhookInfo: async () => ({ pending_update_count: 0 }), send: async () => void n++ };
  await Promise.all([M.runAlertCheck(d), M.runAlertCheck(d), M.runAlertCheck(d), M.runAlertCheck(d)]);
  assert.equal(n, 1);

  resetFakeMongo(); n = 0;
  for (let i = 0; i < 3; i++) await M.recordWebhookMetric(false, 50, now); // 100% errors but only 3 requests
  assert.deepEqual(await M.runAlertCheck(d), [], "below MONITOR_MIN_REQUESTS");
  resetFakeMongo();
  for (let i = 0; i < 30; i++) await M.recordWebhookMetric(true, 50, now);
  assert.deepEqual(await M.runAlertCheck(d), []);
});

test("lease: maybeRunAlertCheck runs at most once per minute across callers and never throws", async () => {
  const now = new Date("2026-10-04T10:00:30Z");
  for (let i = 0; i < 12; i++) await M.recordWebhookMetric(false, 50, now);
  let n = 0;
  const d = { now: () => now, getWebhookInfo: async () => ({ pending_update_count: 0 }), send: async () => void n++ };
  await Promise.all([M.maybeRunAlertCheck(d), M.maybeRunAlertCheck(d)]);
  assert.equal(n, 1);
  await M.maybeRunAlertCheck({ ...d, send: async () => { throw new Error("tg down"); } }); // must not throw
});

test("recordWebhookMetric never throws even if Mongo breaks", async () => {
  (globalThis as any).__navaMongo = { db: () => { throw new Error("boom"); } };
  await assert.doesNotReject(M.recordWebhookMetric(true, 5));
  installFakeMongo();
});
