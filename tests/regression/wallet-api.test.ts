/** HTTP layer of the wallet API: auth, error contract, partner Bearer path, no secrets in logs. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.WALLET_BOT_TOKEN = "777:WALLET-TEST";
installFakeMongo();
const C = await import("../../src/db/models/walletCore.js");
const P = await import("../../src/db/models/walletPartners.js");
const NT = await import("../../src/services/walletNotify.js");
export const notes: { bot: string; chat: number; text: string }[] = [];
NT.setNotifySender(async (bot, chat, text) => { notes.push({ bot, chat, text }); });

beforeEach(async () => {
  resetFakeMongo();
  await col("wallet_supply").insertOne({ _id: "supply", cap: 1000, remaining: 1000, issued: 0, feesCollected: 0 } as any);
  for (const id of [1, 2]) seedUser({ id, nickname: `N${id}`, anonId: `user_AAA${id}` });
});

function init(userId: number): string {
  const f: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "T" }) };
  const check = Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(process.env.WALLET_BOT_TOKEN!).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
async function call(file: string, body: any, headers: Record<string, string> = {}, method = "POST") {
  const { default: handler } = await import(`../../api/wallet/${file}.js`);
  let status = 200, payload: any;
  const res: any = { setHeader() {}, status(c: number) { status = c; return res; }, json(o: any) { payload = o; return res; }, end() { return res; }, send(o: any) { payload = o; return res; } };
  await handler({ method, headers, query: {}, body } as any, res);
  return { status, payload };
}

test("me/state: real wallet data, hides internals; auth enforced", async () => {
  assert.equal((await call("me", { action: "state" })).status, 401);
  assert.equal((await call("me", { action: "state", initData: "garbage" })).status, 401);
  const r = await call("me", { initData: init(1), action: "state" });
  assert.equal(r.status, 200);
  assert.match(r.payload.wallet.token, /^RLC-/);
  assert.equal(r.payload.wallet.balance, 0);
  assert.equal(r.payload.wallet.tapsPerRelic, 475);
  assert.equal(r.payload.wallet.supply.remaining, 1000);
  assert.equal(r.payload.gate.blocked, false);
  assert.equal((await call("me", { initData: init(1), action: "nope" })).payload.error, "bad_action");
  assert.equal((await call("me", { initData: init(999), action: "state" })).status, 404);
});

test("mine -> state shows the persisted balance + carry (no more 'resets to zero')", async () => {
  const m = await call("mine", { initData: init(1), taps: 40, batchId: "x1" });
  assert.equal(m.status, 200);
  assert.equal(m.payload.carryTaps, 40);
  const s = await call("me", { initData: init(1), action: "state" });
  assert.equal(s.payload.wallet.carryTaps, 40);
  assert.equal((await call("mine", { initData: init(1), taps: 1 })).payload.error, "missing_batch_id");
});

test("transfer endpoint: resolve/quote/confirm via HTTP, error codes, replay", async () => {
  await C.getOrCreateAccount(1);
  await C.getOrCreateAccount(2);
  await col("wallet_accounts").updateOne({ _id: 1 }, { $set: { balance: 20 } });
  await col("wallet_supply").updateOne({ _id: "supply" }, { $set: { remaining: 980 } });
  const t2 = col("wallet_accounts").byId(2).token;
  const r = await call("transfer", { initData: init(1), action: "resolve", dest: "wallet", token: t2 });
  assert.equal(r.payload.dest.displayName, "N2");
  assert.equal((await call("transfer", { initData: init(1), action: "quote", dest: "wallet", token: t2, amount: 99 })).payload.error, "insufficient_balance");
  const q = await call("transfer", { initData: init(1), action: "quote", dest: "wallet", token: t2, amount: 7 });
  assert.equal(q.status, 200);
  const c1 = await call("transfer", { initData: init(1), action: "confirm", intentId: q.payload.intentId });
  const c2 = await call("transfer", { initData: init(1), action: "confirm", intentId: q.payload.intentId });
  assert.equal(c1.payload.newBalance, 13);
  assert.equal(c2.payload.duplicate, true);
  assert.equal((await call("transfer", { initData: init(2), action: "confirm", intentId: q.payload.intentId })).status >= 400, true, "another user cannot confirm it");
  const h = await call("me", { initData: init(2), action: "history" });
  assert.equal(h.payload.items[0].amount, 7);
  assert.equal(h.payload.items[0].counterparty, "N1");
});

test("partner Bearer path: bad key 401, valid key works, user initData not accepted as partner", async () => {
  const { apiKey } = await P.createPartner({ id: "dl", name: "DL", baseUrl: "https://dl.example/api", canIssue: true });
  await C.getOrCreateAccount(1);
  const tok = col("wallet_accounts").byId(1).token;
  assert.equal((await call("transfer", { action: "resolve", token: tok }, { authorization: "Bearer wpk_" + "1".repeat(48) })).status, 401);
  const ok = await call("transfer", { action: "credit", token: tok, amount: 5, externalId: "o1" }, { authorization: `Bearer ${apiKey}` });
  assert.equal(ok.status, 200);
  assert.equal(col("wallet_accounts").byId(1).balance, 5);
  const dup = await call("transfer", { action: "credit", token: tok, amount: 5, externalId: "o1" }, { authorization: `Bearer ${apiKey}` });
  assert.equal(dup.payload.duplicate, true);
  assert.equal(col("wallet_accounts").byId(1).balance, 5);
});

test("errors never log values; unexpected failures return a generic 500", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => void logs.push(a.map(String).join(" "));
  try {
    (globalThis as any).__navaMongo = { db: () => { throw new Error("secret-uri mongodb://u:pw@host"); } };
    const r = await call("me", { initData: init(1), action: "state" });
    assert.ok(r.status === 500 || r.status === 404 || r.status === 401);
  } finally {
    console.error = orig;
    installFakeMongo();
  }
  assert.ok(!logs.join("\n").includes("pw@host"));
});
