/** v1.26.0 — Wallet → Nava ژتون deposits, Flow A («آدرس واریز»). Wallet = in-test fake (mocked Mongo/Telegram). */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness({ WALLET_API_URL: "https://wallet.example.com/api/v1/", WALLET_INTEGRATION_ID: "itg_test123", WALLET_API_SECRET: "wsk_supersecret", OWNER_ID: "1" });
const { __setWalletFetch } = await import("../../src/services/wallet/walletClient.js");
const dep = await import("../../src/services/wallet/walletDeposits.js");

interface Req { method: string; url: string; headers: Record<string, string>; body: any }
let reqs: Req[] = [];
let completed: any[] = [];
let addrSeq = 0;
let mode: "ok" | "timeout" | "401" | "500" = "ok";
const res = (status: number, json: any) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => json });
const tx = (id: string, user: number, delivered: number, at: string, extra: any = {}) => ({ id, source: "wallet", status: "COMPLETED", amount: delivered, delivered_amount: delivered, fee: 0, external_user_id: String(user), completed_at: at, ...extra });

beforeEach(() => {
  resetState();
  h.resetCalls();
  reqs = []; completed = []; addrSeq = 0; mode = "ok";
  const addrs: Record<string, string> = {};
  __setWalletFetch(async (url, init) => {
    reqs.push({ method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (mode === "timeout") throw new Error("timeout");
    if (mode === "401") return res(401, { error: { code: "UNAUTHORIZED" } });
    if (mode === "500") return res(500, { error: { code: "INTERNAL" } });
    const path = url.replace("https://wallet.example.com/api/v1", "");
    if (init.method === "POST" && path === "/deposit-codes") {
      const u = JSON.parse(init.body).external_user_id;
      addrs[u] ??= `JTX-ABCD-EFGH-JKLM-N${String(++addrSeq).padStart(3, "0")}`;
      return res(200, { deposit_code: { address: addrs[u], code: addrs[u], external_user_id: u } });
    }
    if (init.method === "GET" && path.startsWith("/transfers?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const after = q.get("completed_after");
      const list = completed.filter((t) => !after || t.completed_at >= after).sort((a, b) => a.completed_at.localeCompare(b.completed_at));
      return res(200, { transactions: list });
    }
    return res(404, {});
  });
  seedUser({ id: 1, anonId: "user_OWN", nickname: "مالک", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 7, anonId: "user_W7", nickname: "کاربر", relicBalance: 10, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
});

const api = () => ({ sendMessage: async (id: number, text: string) => { (globalThis as any).__sent ??= []; (globalThis as any).__sent.push([id, text]); return {} as any; } });
const bal = () => col("users").byId(7).relicBalance;

test("W1. address comes from the Wallet (POST /deposit-codes), is JTX-…, signed per spec, cached and never duplicated", async () => {
  const a = await dep.getDepositAddress(7);
  assert.ok(a.ok && /^JTX-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(a.address));
  const p = reqs[0]!;
  assert.equal(p.url, "https://wallet.example.com/api/v1/deposit-codes");
  assert.equal(p.headers.Authorization, "Bearer itg_test123.wsk_supersecret");
  assert.match(p.headers["X-Wallet-Nonce"]!, /^[A-Za-z0-9_-]{16,64}$/);
  assert.ok(Math.abs(Number(p.headers["X-Wallet-Timestamp"]) - Date.now() / 1000) < 5);
  assert.deepEqual(p.body, { external_user_id: "7" });
  const again = await dep.getDepositAddress(7);
  assert.ok(again.ok && again.address === a.address);
  assert.equal(reqs.length, 1, "second call is served from the cache");
  seedUser({ id: 8, anonId: "user_W8", nickname: "دیگر", relicBalance: 0, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  const b = await dep.getDepositAddress(8);
  assert.ok(b.ok && b.address !== a.address);
});

test("W2. a COMPLETED transfer credits delivered_amount once, tells the user, writes a ledger row", async () => {
  completed = [tx("tx_1", 7, 100, "2026-10-24T10:00:00.000Z", { fee: 5, total_charged: 105 })];
  const r = await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(r.credited, 1);
  assert.equal(bal(), 110);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER").length, 1);
  assert.ok(((globalThis as any).__sent as any[]).some(([id, t]) => id === 7 && /۱۰۰|100 ژتون/.test(t) && /ژتون/.test(t)));
  assert.equal(col("wallet_deposits").byId("tx_1").amount, 100);
});

test("W3. the same transaction again (repeat poll / overlap / parallel) is credited ONCE", async () => {
  completed = [tx("tx_1", 7, 40, "2026-10-24T10:00:00.000Z")];
  await Promise.all([1, 2, 3, 4].map(() => dep.syncWalletDeposits(api() as any, { force: true })));
  await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(bal(), 50);
  assert.equal(col("wallet_deposits").all().length, 1);
});

test("W4. fee taken from the amount: delivered_amount (not amount) is credited", async () => {
  completed = [tx("tx_f", 7, 95, "2026-10-24T10:00:00.000Z", { amount: 100, fee: 5, fee_mode: "FROM_AMOUNT", total_charged: 100 })];
  await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(bal(), 105);
});

test("W5. only COMPLETED credits; garbage / non-integer / unknown user is never credited", async () => {
  completed = [
    { ...tx("tx_p", 7, 50, "2026-10-24T10:00:00.000Z"), status: "PENDING" },
    tx("tx_d", 7, 1.5, "2026-10-24T10:01:00.000Z"),
    tx("tx_n", 7, -5, "2026-10-24T10:02:00.000Z"),
    tx("tx_u", 999, 20, "2026-10-24T10:03:00.000Z"),
    tx("tx_x", 7, 20, "2026-10-24T10:04:00.000Z", { external_user_id: "abc" }),
  ];
  await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(bal(), 10);
  assert.equal(col("wallet_deposits").all().length, 0);
});

test("W6. cursor: later syncs ask completed_after the last processed transfer and credit only new ones", async () => {
  completed = [tx("tx_1", 7, 10, "2026-10-24T10:00:00.000Z")];
  await dep.syncWalletDeposits(api() as any, { force: true });
  completed.push(tx("tx_2", 7, 5, "2026-10-24T10:05:00.000Z"));
  reqs = [];
  await dep.syncWalletDeposits(api() as any, { force: true });
  assert.match(reqs[0]!.url, /completed_after=2026-10-24T10%3A00%3A00\.000Z/);
  assert.match(reqs[0]!.url, /status=COMPLETED/);
  assert.equal(bal(), 25);
});

test("W7. 401 credits nothing, alerts the owner once; timeout / 5xx is not a failure and a later run succeeds", async () => {
  completed = [tx("tx_1", 7, 10, "2026-10-24T10:00:00.000Z")];
  (globalThis as any).__sent = [];
  mode = "401";
  const r1 = await dep.syncWalletDeposits(api() as any, { force: true });
  const r2 = await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(r1.error, "UNAUTHORIZED");
  assert.equal(r2.error, "UNAUTHORIZED");
  assert.equal(((globalThis as any).__sent as any[]).filter(([id]) => id === 1).length, 1, "owner told once");
  assert.equal(bal(), 10);
  for (const m of ["timeout", "500"] as const) {
    mode = m;
    const r = await dep.syncWalletDeposits(api() as any, { force: true });
    assert.ok(r.error);
    assert.equal(bal(), 10);
  }
  mode = "ok";
  const ok = await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(ok.credited, 1);
  assert.equal(bal(), 20);
});

test("W8. not configured / switched off → no call at all", async () => {
  await col("wallet_integration").updateOne?.({ _id: "singleton" } as any, { $set: { enabled: false } } as any, { upsert: true } as any);
  const r = await dep.syncWalletDeposits(api() as any, { force: true });
  assert.equal(r.ran, false);
  assert.equal(reqs.length, 0);
  const a = await dep.getDepositAddress(7);
  assert.ok(!a.ok);
});

test("W9. shop: «ژتون» menu is ONE message edited in place; wallet screen shows the JTX address; back returns", async () => {
  h.resetCalls();
  await h.text(7, "👑 ژتون");
  const first = h.of("sendMessage", 7).find((c) => c.payload.reply_markup?.inline_keyboard);
  assert.match(JSON.stringify(first?.payload.reply_markup), /shop:stars/);
  assert.match(JSON.stringify(first?.payload.reply_markup), /shop:wallet/);
  const sentBefore = h.of("sendMessage", 7).length;
  await h.callback(7, "shop:wallet");
  const edit = h.last("editMessageText", 7);
  assert.match(String(edit?.payload.text), /JTX-[A-Z0-9]{4}-/);
  assert.match(JSON.stringify(edit?.payload.reply_markup), /shop:home/);
  await h.callback(7, "shop:home");
  assert.equal(h.of("sendMessage", 7).length, sentBefore, "no new message was sent while browsing");
});
