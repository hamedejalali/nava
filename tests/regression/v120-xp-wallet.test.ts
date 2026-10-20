/** v1.20.0 — Wallet -> Nava XP API: signing, replay, token lifecycle, integer-only amounts, idempotent credit. (mocked Mongo; no real Wallet, no real Atlas) */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const KEY = "wallet-key-1";
const SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-0001";
const h = await createHarness({ WALLET_API_KEY_ID: KEY, WALLET_API_SECRET: SECRET });
void h;
const { handleWalletRequest } = await import("../../src/services/wallet/walletApi.js");
const { signWalletRequest, resetWalletIndexMemo, setWalletIntegrationEnabled } = await import("../../src/services/wallet/walletAuth.js");
const { issueTransferToken, revokeTransferToken, resetTransferTokenIndexMemo, hashToken } = await import("../../src/services/wallet/transferToken.js");

let nonceN = 0;
async function call(op: string, body: unknown, opts: { secret?: string; ts?: number; nonce?: string; key?: string; raw?: string; method?: string; omit?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(Math.floor((opts.ts ?? Date.now()) / 1000));
  const nonce = opts.nonce ?? `nonce-${Date.now()}-${++nonceN}-abcdefgh`;
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = {
    "x-wallet-key-id": opts.key ?? KEY,
    "x-wallet-timestamp": ts,
    "x-wallet-nonce": nonce,
    "x-wallet-signature": signWalletRequest(opts.secret ?? SECRET, ts, nonce, method, `/api/wallet/v1/${op}`, raw),
  };
  if (opts.omit) delete headers[opts.omit];
  return handleWalletRequest({ method, op, rawBody: raw, headers, ip: "1.2.3.4" }, { notifyUser: async () => {}, notifyOwner: async () => {} });
}
const bal = (id: number) => col("users").byId(id).relicBalance as number;
const code = (r: any) => r.body?.error?.code;

let tokenA = "";
let tokenB = "";
beforeEach(async () => {
  resetState();
  resetWalletIndexMemo();
  resetTransferTokenIndexMemo();
  seedUser({ id: 1, anonId: "user_AAA1", nickname: "علی", relicBalance: 40, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  seedUser({ id: 2, anonId: "user_AAA2", nickname: "سارا", relicBalance: 7, relicInitialized: true, onboardingStep: "COMPLETED" } as any);
  tokenA = (await issueTransferToken(1)).token;
  tokenB = (await issueTransferToken(2)).token;
});
const credit = (over: Record<string, unknown> = {}, o = {}) => call("credit", { transactionId: `tx-${Math.random().toString(36).slice(2, 12)}`, idempotencyKey: `ik-${Math.random().toString(36).slice(2, 12)}`, userToken: tokenA, amount: 10, ...over }, o);

test("W1. tokens: 256-bit random, unique per user, only the HASH is stored, rotating revokes the old one", async () => {
  assert.notEqual(tokenA, tokenB);
  assert.match(tokenA, /^nxp_[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify(col("xp_transfer_tokens").all());
  assert.ok(!stored.includes(tokenA) && !stored.includes(tokenB), "no raw token in the database");
  assert.ok(stored.includes(hashToken(tokenA)));
  const next = (await issueTransferToken(1)).token;
  assert.equal(code(await credit({ userToken: tokenA })), "token_revoked");
  assert.equal((await credit({ userToken: next })).status, 200);
  await revokeTransferToken(1);
  assert.equal(code(await credit({ userToken: next })), "token_revoked");
});

test("W2. authentication: missing headers, wrong key, wrong secret, bad signature, stale / future timestamp, wrong path -> nothing credited", async () => {
  const before = bal(1);
  assert.equal(code(await credit({}, { omit: "x-wallet-signature" })), "missing_auth_headers");
  assert.equal(code(await credit({}, { key: "other" })), "invalid_credentials");
  assert.equal(code(await credit({}, { secret: "wrong-secret-wrong-secret-0000000" })), "invalid_signature");
  assert.equal(code(await credit({}, { ts: Date.now() - 10 * 60_000 })), "timestamp_out_of_window");
  assert.equal(code(await credit({}, { ts: Date.now() + 10 * 60_000 })), "timestamp_out_of_window");
  assert.equal(code(await credit({}, { nonce: "short" })), "invalid_nonce");
  assert.equal(bal(1), before);
  // a body changed after signing is rejected
  const good = JSON.stringify({ transactionId: "tx-tamper-01", idempotencyKey: "ik-tamper-01", userToken: tokenA, amount: 10 });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signWalletRequest(SECRET, ts, "nonce-tamper-0123456789", "POST", "/api/wallet/v1/credit", good);
  const r = await handleWalletRequest({ method: "POST", op: "credit", rawBody: good.replace('"amount":10', '"amount":9999'), headers: { "x-wallet-key-id": KEY, "x-wallet-timestamp": ts, "x-wallet-nonce": "nonce-tamper-0123456789", "x-wallet-signature": sig }, ip: "1.2.3.4" });
  assert.equal(code(r), "invalid_signature");
  assert.equal(bal(1), before);
  assert.equal((await call("credit", {}, { method: "GET" })).status, 405);
  assert.equal((await call("nope", {})).status, 404);
});

test("W3. replay: the very same signed request (same nonce) is refused the second time", async () => {
  const body = { transactionId: "tx-replay-0001", idempotencyKey: "ik-replay-0001", userToken: tokenA, amount: 5 };
  const o = { nonce: "nonce-replay-0123456789" };
  assert.equal((await call("credit", body, o)).status, 200);
  const again = await call("credit", body, o);
  assert.equal(code(again), "replayed_request");
  assert.equal(bal(1), 45, "credited once");
});

test("W4. amounts: only positive WHOLE numbers; decimals, zero, negative, text, huge, null are refused and credit nothing", async () => {
  for (const amount of [1.5, 0.1, 0, -5, "abc", "10.5", null, undefined, 1e10, Number.NaN, Infinity, [], {}, "", "1e3"]) {
    const r = await credit({ amount });
    assert.equal(r.status, 400, `amount=${JSON.stringify(amount)}`);
    assert.equal(code(r), "invalid_amount");
  }
  assert.equal(bal(1), 40);
});

test("W5. valid credits (1, 10, 1000) add EXACTLY that many XP to the token's owner only; other balances untouched", async () => {
  for (const [i, a] of [1, 10, 1000].entries()) {
    const r = await credit({ amount: a, transactionId: `tx-valid-000${i}`, idempotencyKey: `ik-valid-000${i}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.transfer.amount, a);
  }
  assert.equal(bal(1), 40 + 1011);
  assert.equal(bal(2), 7);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER").length, 3);
});

test("W6. the Wallet's fee is ignored: Nava credits exactly the net amount it is told", async () => {
  const r = await credit({ amount: 100, walletFee: 5 });
  assert.equal(r.status, 200);
  assert.equal(bal(1), 140);
});

test("W7. duplicate transactionId (retry): same answer, flagged duplicate, credited ONCE; different data under the same id is a conflict", async () => {
  const body = { transactionId: "tx-dup-000001", idempotencyKey: "ik-dup-000001", userToken: tokenA, amount: 25 };
  const a = await call("credit", body);
  const b = await call("credit", body);
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(bal(1), 65);
  assert.equal(code(await call("credit", { ...body, amount: 26 })), "transaction_conflict");
  assert.equal(code(await call("credit", { ...body, transactionId: "tx-dup-000002" })), "idempotency_conflict");
  assert.equal(bal(1), 65);
});

test("W8. 20 PARALLEL requests with the same ids: exactly one credit, the rest are duplicates", async () => {
  const body = { transactionId: "tx-par-000001", idempotencyKey: "ik-par-000001", userToken: tokenA, amount: 10 };
  const rs = await Promise.all(Array.from({ length: 20 }, () => call("credit", body)));
  assert.equal(bal(1), 50);
  assert.equal(rs.filter((r) => r.status === 200 && r.body.duplicate === false).length, 1);
  assert.equal(rs.filter((r) => r.status === 200).length, 20);
  assert.equal(col("xp_wallet_transfers").all().length, 1);
});

test("W9. a retry AFTER the user rotated his token is still answered as the completed transfer (no second credit)", async () => {
  const body = { transactionId: "tx-rot-0000001", idempotencyKey: "ik-rot-0000001", userToken: tokenA, amount: 10 };
  assert.equal((await call("credit", body)).status, 200);
  await issueTransferToken(1);
  const retry = await call("credit", body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(bal(1), 50);
  // but a NEW transaction with the old token is refused
  assert.equal(code(await credit({ userToken: tokenA })), "token_revoked");
});

test("W10. status endpoint: found / not found, and it never leaks Telegram ids or balances", async () => {
  await credit({ transactionId: "tx-stat-000001", idempotencyKey: "ik-stat-000001", amount: 3 });
  const f = await call("status", { transactionId: "tx-stat-000001" });
  assert.equal(f.body.found, true);
  assert.equal(f.body.transfer.status, "completed");
  const txt = JSON.stringify(f.body);
  assert.ok(!/userId|balance|"1"/.test(txt));
  assert.equal((await call("status", { transactionId: "tx-never-000001" })).body.found, false);
  assert.equal((await call("status", { transactionId: "x" })).status, 400);
});

test("W11. unknown / malformed token, banned user, unfinished onboarding -> refused, nothing credited", async () => {
  assert.equal(code(await credit({ userToken: "nxp_" + "A".repeat(43) })), "invalid_token");
  assert.equal(code(await credit({ userToken: "garbage" })), "invalid_token");
  col("users").updateOne({ _id: 1 }, { $set: { banned: true } });
  assert.equal(code(await credit({})), "user_unavailable");
  col("users").updateOne({ _id: 1 }, { $set: { banned: false, onboardingStep: "ASK_AGE" } });
  assert.equal(code(await credit({})), "user_unavailable");
  assert.equal(bal(1), 40);
});

test("W12. resolve tells who would be credited (public id + name only); guessing tokens is throttled", async () => {
  const r = await call("resolve", { userToken: tokenB });
  assert.deepEqual(r.body.recipient, { id: "user_AAA2", name: "سارا" });
  let blocked = false;
  for (let i = 0; i < 14; i++) {
    const x = await call("resolve", { userToken: "nxp_" + String.fromCharCode(65 + (i % 20)).repeat(43) });
    if (code(x) === "too_many_invalid_tokens") blocked = true;
  }
  assert.ok(blocked, "after ~10 misses the integration is throttled");
});

test("W13. the owner's switch turns the integration off (403) and on again; the secret is never echoed", async () => {
  await setWalletIntegrationEnabled(false, 900);
  const off = await credit({});
  assert.equal(off.status, 403);
  await setWalletIntegrationEnabled(true, 900);
  const on = await credit({});
  assert.equal(on.status, 200);
  assert.ok(!JSON.stringify([off, on]).includes(SECRET));
  assert.ok(!JSON.stringify(col("wallet_audit").all()).includes(SECRET));
});

test("W14. oversize bodies are refused before any work", async () => {
  const r = await call("credit", {}, { raw: JSON.stringify({ pad: "x".repeat(5000) }) });
  assert.equal(r.status, 413);
});
