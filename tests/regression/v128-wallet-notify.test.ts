/** v1.28.0 — a deposit notice is marked delivered only after Telegram accepted it; failures are retried (mocked Mongo/Telegram) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

await createHarness({ WALLET_API_URL: "https://wallet.example.com/api/v1/", WALLET_INTEGRATION_ID: "itg_test123", WALLET_API_SECRET: "wsk_supersecret", OWNER_ID: "1" });
const dep = await import("../../src/services/wallet/walletDeposits.js");

const tx = (id: string, user: number, n: number) => ({ id, source: "wallet", status: "COMPLETED", amount: n, delivered_amount: n, fee: 0, external_user_id: String(user), completed_at: "2026-10-01T00:00:00Z" }) as any;
function api(mode: { fail: any }) {
  const sent: any[] = [];
  return { sent, api: { async sendMessage(id: number, text: string) { if (mode.fail) throw mode.fail; sent.push({ id, text }); return {} as any; } } as any };
}
beforeEach(() => { resetState(); seedUser({ id: 7, anonId: "user_W0007", nickname: "w", relicBalance: 0, relicInitialized: true } as any); });

test("N1. failed send → NOT marked delivered, retried later, delivered exactly once, credit untouched", async () => {
  const m = { fail: { error_code: 500 } as any };
  const { api: a, sent } = api(m);
  const out = await dep.creditTransfer(tx("T1", 7, 5));
  assert.equal(out.credited, true);
  await dep.announceCredit(a, out as any);
  assert.equal(col("wallet_deposits").byId("T1")!.notifiedAt, undefined);
  assert.equal(col("wallet_deposits").byId("T1")!.notifyAttempts, 1);
  assert.equal(sent.length, 0);
  m.fail = null;
  assert.equal(await dep.retryPendingAnnouncements(a), 1);
  assert.equal(sent.filter((s) => s.id === 7).length, 1);
  assert.ok(col("wallet_deposits").byId("T1")!.notifiedAt);
  assert.equal(await dep.retryPendingAnnouncements(a), 0, "nothing left to retry");
  assert.equal(((col("users").byId(7) as any).relicBalance), 5, "credited once");
});

test("N2. a blocked user (403) is final: marked, never retried", async () => {
  const m = { fail: { error_code: 403 } as any };
  const { api: a } = api(m);
  await dep.announceCredit(a, (await dep.creditTransfer(tx("T2", 7, 3))) as any);
  const row = col("wallet_deposits").byId("T2")!;
  assert.ok(row.notifiedAt);
  assert.equal(row.notifyFailed, "telegram_403");
  assert.equal(await dep.retryPendingAnnouncements(a), 0);
});

test("N3. attempts are capped", async () => {
  const m = { fail: { error_code: 500 } as any };
  const { api: a } = api(m);
  await dep.announceCredit(a, (await dep.creditTransfer(tx("T3", 7, 3))) as any);
  for (let i = 0; i < 12; i++) await dep.retryPendingAnnouncements(a);
  assert.equal(col("wallet_deposits").byId("T3")!.notifyAttempts, 10);
});
