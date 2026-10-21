/** v1.21.0 — Nava → Wallet XP deposit, per the Wallet's integration spec. Wallet = in-test fake (no real Wallet, mocked Mongo/Telegram). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ WALLET_API_URL: "https://wallet.example.com/api/v1/", WALLET_INTEGRATION_ID: "itg_test123", WALLET_API_SECRET: "wsk_supersecret" });
const { __setWalletFetch } = await import("../../src/services/wallet/walletClient.js");
const dep = await import("../../src/services/wallet/walletDeposits.js");
const TOKEN = "PW-AB12-CD34-EF56-GH78";

interface Req { method: string; url: string; headers: Record<string, string>; body: any }
let reqs: Req[] = [];
let txs: Record<string, any> = {};
let byKey: Record<string, string> = {};
let plan: { post?: Array<"timeout" | "500" | "ok" | { err: number; code: string }> } = {};
let seq = 0;

const res = (status: number, json: any, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => json });

function installWallet() {
  __setWalletFetch(async (url, init) => {
    const r: Req = { method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    reqs.push(r);
    const path = url.replace("https://wallet.example.com/api/v1", "");
    if (r.method === "POST" && path === "/transfers") {
      const step = plan.post?.shift() ?? "ok";
      if (step === "timeout") throw new Error("timeout");
      if (step === "500") return res(500, { error: { code: "INTERNAL" } });
      if (typeof step === "object") return res(step.err, { error: { code: step.code, message: "x" } });
      const existing = byKey[r.body.idempotency_key];
      if (existing) return res(200, { transaction: txs[existing], replayed: true });
      const id = "tx_" + ++seq;
      const fee = Math.ceil((r.body.amount * 5) / 100);
      txs[id] = { id, status: "PENDING", amount: r.body.amount, fee, total: r.body.amount + fee, fee_percent: 5, external_user_id: r.body.external_user_id, idempotency_key: r.body.idempotency_key, failure_code: null, expires_at: new Date(Date.now() + 600_000).toISOString() };
      byKey[r.body.idempotency_key] = id;
      return res(202, { transaction: txs[id], replayed: false });
    }
    const m = path.match(/^\/transfers\/(.+)$/);
    if (r.method === "GET" && m) return txs[m[1]] ? res(200, { transaction: txs[m[1]] }) : res(404, { error: { code: "NOT_FOUND" } });
    return res(404, {});
  });
}

beforeEach(() => {
  resetState();
  h.resetCalls();
  reqs = []; txs = {}; byKey = {}; plan = {}; seq = 0;
  installWallet();
  seedUser({ id: 7, anonId: "user_W7", nickname: "کاربر", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

const start = async (amount = 100) => dep.createDeposit({ userId: 7, chatId: 7, rawToken: TOKEN, amount });
const bal = () => col("users").byId(7).relicBalance;

test("D1. request follows the spec: Bearer id.secret, fresh timestamp+nonce, idempotency key, integer amount, token — and nothing is credited at PENDING", async () => {
  const r = await start(100);
  assert.ok(r.ok);
  const p = reqs[0];
  assert.equal(p.method, "POST");
  assert.equal(p.url, "https://wallet.example.com/api/v1/transfers", "trailing slash normalised");
  assert.equal(p.headers.Authorization, "Bearer itg_test123.wsk_supersecret");
  assert.match(p.headers["X-Wallet-Nonce"], /^[A-Za-z0-9_-]{16,64}$/);
  assert.ok(Math.abs(Number(p.headers["X-Wallet-Timestamp"]) - Date.now() / 1000) < 5);
  assert.equal(p.headers["Content-Type"], "application/json");
  assert.deepEqual([p.body.amount, p.body.wallet_token, p.body.external_user_id], [100, TOKEN, "7"]);
  assert.match(p.body.idempotency_key, /^nava-7-[0-9a-f]{16}$/);
  assert.equal(bal(), 10, "PENDING credits nothing");
  const row = col("wallet_deposits").all()[0];
  assert.equal(row.status, "pending");
  assert.equal(row.walletToken, undefined, "token dropped after the transfer id is known");
  assert.equal(row.fee, 5);
  assert.equal(row.total, 105);
});

test("D2. COMPLETED credits `amount` (not total), once — repeated / parallel polls never double-credit; ledger row exists", async () => {
  const r = await start(101);
  assert.ok(r.ok);
  txs.tx_1.status = "PROCESSING";
  assert.equal((await dep.syncDeposit(r.deposit._id))!.credited, false);
  assert.equal(bal(), 10, "PROCESSING is not a credit");
  txs.tx_1.status = "COMPLETED";
  const outs = await Promise.all([1, 2, 3, 4].map(() => dep.syncDeposit(r.deposit._id)));
  assert.equal(outs.filter((o) => o!.credited).length, 1);
  assert.equal(bal(), 111, "101 credited, fee 6 not credited");
  await dep.syncDeposit(r.deposit._id);
  assert.equal(bal(), 111);
  const led = col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER");
  assert.equal(led.length, 1);
  assert.equal(led[0]._id, "walletdep:tx_1");
  assert.equal(col("wallet_deposits").all()[0].status, "completed");
});

test("D3. FAILED reports the code, credits nothing; REQUIRES_RECONCILIATION keeps waiting (not a failure)", async () => {
  const r = await start(50);
  assert.ok(r.ok);
  txs.tx_1.status = "REQUIRES_RECONCILIATION";
  assert.equal((await dep.syncDeposit(r.deposit._id))!.deposit.status, "pending");
  txs.tx_1.status = "FAILED"; txs.tx_1.failure_code = "USER_REJECTED";
  const o = await dep.syncDeposit(r.deposit._id);
  assert.equal(o!.deposit.status, "failed");
  assert.equal(o!.deposit.failureCode, "USER_REJECTED");
  assert.equal(bal(), 10);
});

test("D4. timeout / 500 on POST is retried with the SAME idempotency key and a NEW nonce — one transfer only", async () => {
  plan.post = ["timeout", "500", "ok"];
  const r = await start(40);
  assert.ok(r.ok);
  const posts = reqs.filter((q) => q.method === "POST");
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((q) => q.body.idempotency_key)).size, 1);
  assert.equal(new Set(posts.map((q) => q.headers["X-Wallet-Nonce"])).size, 3);
  assert.equal(Object.keys(txs).length, 1);
});

test("D5. uncertain POST (all retries time out) keeps the row; a later sync re-POSTs with the same key and continues", async () => {
  plan.post = ["timeout", "timeout", "timeout"];
  const r = await start(40);
  assert.ok(!r.ok && r.reason === "wallet_error" && r.deposit);
  assert.equal(col("wallet_deposits").all()[0].status, "creating");
  const o = await dep.syncDeposit(r.deposit!._id);
  assert.equal(o!.deposit.status, "pending");
  assert.equal(Object.keys(txs).length, 1);
  assert.equal(reqs.filter((q) => q.method === "POST").at(-1)!.body.idempotency_key, r.deposit!.idempotencyKey);
});

test("D6. 4xx errors fail cleanly with a friendly code and drop the token; amounts/tokens are validated before any call", async () => {
  plan.post = [{ err: 404, code: "WALLET_USER_NOT_FOUND" }];
  const r = await start(10);
  assert.ok(!r.ok && r.reason === "wallet_error" && r.code === "WALLET_USER_NOT_FOUND");
  const row = col("wallet_deposits").all()[0];
  assert.equal(row.status, "failed");
  assert.equal(row.walletToken, undefined);
  reqs = [];
  const bad = await dep.createDeposit({ userId: 7, chatId: 7, rawToken: "PW-nope", amount: 5 });
  assert.ok(!bad.ok && bad.reason === "bad_token");
  assert.equal(reqs.length, 0);
});

test("D7. a Wallet answer that does not match the deposit (amount / user) is never credited", async () => {
  const r = await start(100);
  assert.ok(r.ok);
  txs.tx_1.status = "COMPLETED"; txs.tx_1.amount = 5000;
  const o = await dep.syncDeposit(r.deposit._id);
  assert.equal(o!.mismatch, true);
  assert.equal(bal(), 10);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER").length, 0);
});

test("D8. only one active deposit per user; the sweeper credits an approved deposit the user never came back to and tells him once", async () => {
  const r = await start(100);
  assert.ok(r.ok);
  const again = await start(5);
  assert.ok(!again.ok && again.reason === "active_exists");
  txs.tx_1.status = "COMPLETED";
  const api = { sendMessage: async (...a: any[]) => { sent.push(a); return {}; } } as any;
  const sent: any[] = [];
  const s1 = await dep.sweepPendingDeposits(api);
  const s2 = await dep.sweepPendingDeposits(api);
  assert.equal(s1.credited, 1);
  assert.equal(s2.checked, 0);
  assert.equal(bal(), 110);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0][1]), /واریز انجام شد/);
});

test("D9. not configured / switched off → feature unavailable, no network call", async () => {
  const { setWalletIntegrationEnabled } = await import("../../src/services/wallet/walletSettings.js");
  await setWalletIntegrationEnabled(false, 1);
  const r = await start(10);
  assert.ok(!r.ok && r.reason === "unavailable");
  assert.equal(reqs.length, 0);
});

test("D10. bot flow end-to-end: button → amount → token (message deleted) → request → «بررسی وضعیت» credits", async () => {
  await h.callback(7, "xp:wallet");
  await h.callback(7, "xp:new");
  await h.text(7, "۲۵"); // Persian digits
  assert.equal(reqs.length, 0);
  await h.text(7, "نادرست");
  assert.equal(reqs.length, 0, "bad token format is refused locally");
  h.resetCalls();
  const p = h.text(7, TOKEN);
  // the user approves inside the Wallet bot while Nava is polling
  await new Promise((r) => setTimeout(r, 50));
  txs.tx_1 && (txs.tx_1.status = "COMPLETED");
  await p;
  assert.ok(h.of("deleteMessage").length >= 1, "token message deleted");
  assert.equal(bal(), 35);
  assert.ok(h.of("sendMessage", 7).some((c: any) => /واریز انجام شد/.test(String(c.payload.text))));
});

test("D11. button flow when approval comes later: first press = still waiting, after approval = credited once", async () => {
  await h.callback(7, "xp:new");
  await h.text(7, "20");
  const { __setPollForTests } = await import("../../src/services/wallet/walletDeposits.js").then((m) => ({ __setPollForTests: null as any, ...m }));
  void __setPollForTests;
  await h.text(7, TOKEN);
  const id = col("wallet_deposits").all()[0]._id;
  h.resetCalls();
  await h.callback(7, `xp:chk:${id}`);
  assert.ok(h.of("sendMessage", 7).some((c: any) => /هنوز توی ولت تایید نشده/.test(String(c.payload.text))));
  txs.tx_1.status = "COMPLETED";
  await h.callback(7, `xp:chk:${id}`);
  await h.callback(7, `xp:chk:${id}`);
  assert.equal(bal(), 30);
  await h.callback(8, `xp:chk:${id}`); // someone else's deposit id
  assert.equal(bal(), 30);
});
