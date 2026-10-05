/** Wallet v1.11.0: separate balance, supply cap, mining, transfers, partners, tasks, tx log. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMongo, resetFakeMongo, seedUser, col } from "../harness/fakeMongo.js";

process.env.BOT_TOKEN ||= "123456:TEST-TOKEN";
process.env.WEBHOOK_SECRET ||= "s";
process.env.MONGODB_URI ||= "mongodb://fake";
process.env.WALLET_BOT_TOKEN = "777:WALLET-TEST";
installFakeMongo();
const C = await import("../../src/db/models/walletCore.js");
const M = await import("../../src/db/models/walletMining.js");
const T = await import("../../src/db/models/walletTransfers.js");
const P = await import("../../src/db/models/walletPartners.js");
const K = await import("../../src/db/models/walletTasks.js");
const L = await import("../../src/services/walletTxLog.js");
const NT = await import("../../src/services/walletNotify.js");
export const notes: { bot: string; chat: number; text: string }[] = [];
NT.setNotifySender(async (bot, chat, text) => { notes.push({ bot, chat, text }); });

const CAP = 1000;
beforeEach(async () => {
  resetFakeMongo();
  await col("wallet_supply").insertOne({ _id: "supply", cap: CAP, remaining: CAP, issued: 0, feesCollected: 0 } as any);
  for (const id of [1, 2, 3]) seedUser({ id, nickname: `N${id}`, anonId: `user_AAA${id}`, relicBalance: 0 });
  P.setPartnerFetcher(null);
});

async function fund(id: number, amount: number) {
  await C.getOrCreateAccount(id);
  await col("wallet_accounts").updateOne({ _id: id }, { $inc: { balance: amount } });
  await col("wallet_supply").updateOne({ _id: "supply" }, { $inc: { remaining: -amount, issued: amount } });
}
const set = (c: string, id: any, patch: any) => col(c).updateOne({ _id: id }, { $set: patch });
const tok = (id: number) => col("wallet_accounts").byId(id).token as string;
const conserved = () => {
  const s = col("wallet_supply").byId("supply");
  const bal = col("wallet_accounts").all().reduce((a: number, x: any) => a + x.balance, 0);
  const par = col("wallet_partners").all().reduce((a: number, x: any) => a + x.balance, 0);
  const nava = col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER_IN").reduce((a: number, x: any) => a + x.amount, 0);
  return s.remaining + s.feesCollected + bal + par + nava;
};

test("token format: unique, normalised, masked; account creation is idempotent", async () => {
  const a = await C.getOrCreateAccount(1);
  const again = await C.getOrCreateAccount(1);
  assert.equal(a.token, again.token);
  assert.match(a.token, /^RLC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(C.normalizeWalletToken(a.token.toLowerCase().replace(/-/g, " ")), a.token);
  assert.equal(C.normalizeWalletToken("RLC-0000-0000-0000-0000"), null);
  assert.equal(C.normalizeWalletToken("user_AAA1"), null);
  assert.ok(!C.maskToken(a.token).includes(a.token.slice(9, 13)));
  const [x, y] = await Promise.all([C.getOrCreateAccount(2), C.getOrCreateAccount(2)]);
  assert.equal(x.token, y.token);
  assert.equal(col("wallet_accounts").all().filter((d: any) => d._id === 2).length, 1);
});

test("mining credits the WALLET (not Nava), from the finite supply, with carry and idempotent replay", async () => {
  const r1 = await M.creditMiningTaps(1, 50, "b1");
  assert.equal(r1.acceptedTaps, 50);
  assert.equal(r1.creditedRelic, 0);
  assert.equal(r1.carryTaps, 50);
  assert.equal(col("users").byId(1).relicBalance, 0, "Nava balance untouched");
  await set("wallet_mining_state", 1, { lastSyncAt: new Date(Date.now() - 100_000) });
  const r2 = await M.creditMiningTaps(1, 900, "b2");
  assert.equal(r2.creditedRelic, 2);
  assert.equal(col("wallet_accounts").byId(1).balance, 2);
  assert.equal(col("wallet_supply").byId("supply").remaining, CAP - 2);
  const dup = await M.creditMiningTaps(1, 900, "b2");
  assert.equal(dup.duplicate, true);
  assert.equal(col("wallet_accounts").byId(1).balance, 2);
  assert.equal(conserved(), CAP);
  assert.equal(col("wallet_ledger").all().filter((l: any) => l.kind === "mining").length, 1);
});

test("supply exhaustion: nothing is minted beyond the cap", async () => {
  await col("wallet_supply").updateOne({ _id: "supply" }, { $set: { remaining: 1 } });
  await M.creditMiningTaps(1, 50, "a");
  await set("wallet_mining_state", 1, { lastSyncAt: new Date(Date.now() - 100_000) });
  const r = await M.creditMiningTaps(1, 2000, "b");
  assert.equal(r.creditedRelic, 1);
  assert.equal(r.supplyExhausted, true);
  assert.equal(col("wallet_supply").byId("supply").remaining, 0);
  await set("wallet_mining_state", 1, { lastSyncAt: new Date(Date.now() - 100_000) });
  const r2 = await M.creditMiningTaps(1, 2000, "c");
  assert.equal(r2.creditedRelic, 0);
  assert.equal(col("wallet_accounts").byId(1).balance, 1);
});

test("owner top-up / cap changes keep the invariant and cannot go below circulation", async () => {
  await fund(1, 100);
  await C.addSupply(500);
  assert.equal(col("wallet_supply").byId("supply").cap, CAP + 500);
  await assert.rejects(C.setSupplyCap(50), /below_circulation/);
  await C.setSupplyCap(CAP + 500 - 10);
  assert.equal(conserved(), CAP + 490);
});

test("mining gate: taps stop at the threshold until the gate task is approved", async () => {
  const t = await K.createTask({ title: "join", type: "channel", chatRef: "@c", reward: 3, gate: true, afterTaps: 5 });
  K.setMembershipChecker(async () => false);
  const r = await M.creditMiningTaps(1, 30, "g1");
  assert.equal(r.acceptedTaps, 5);
  assert.equal(r.gate.blocked, true);
  assert.equal(r.gate.task?.id, t._id);
  await set("wallet_mining_state", 1, { lastSyncAt: new Date(Date.now() - 100_000) });
  assert.equal((await M.creditMiningTaps(1, 30, "g2")).acceptedTaps, 0);
  await assert.rejects(K.claimTask(1, t._id), /not_joined/);
  K.setMembershipChecker(async () => true);
  const done = await K.claimTask(1, t._id);
  assert.equal(done.status, "done");
  assert.equal(done.newBalance, 3);
  await assert.rejects(K.claimTask(1, t._id), /already_done/);
  await set("wallet_mining_state", 1, { lastSyncAt: new Date(Date.now() - 100_000) });
  assert.equal((await M.creditMiningTaps(1, 30, "g3")).acceptedTaps, 30);
  assert.equal(conserved(), CAP);
});

test("manual task: pending -> owner approve credits once; reject can be retried; concurrent approve pays once", async () => {
  const seen: string[] = [];
  K.setReviewNotifier(async (c) => void seen.push(c._id));
  const t = await K.createTask({ title: "insta", type: "instagram", url: "https://i", reward: 7 });
  const r = await K.claimTask(1, t._id);
  assert.equal(r.status, "pending");
  assert.equal(seen.length, 1);
  assert.equal((await K.claimTask(1, t._id)).status, "pending");
  assert.equal(seen.length, 1, "no duplicate review message");
  const results = await Promise.all([K.reviewClaim(`${t._id}:1`, true, 900), K.reviewClaim(`${t._id}:1`, true, 900)]);
  assert.deepEqual(results.sort(), ["already", "approved"]);
  assert.equal(col("wallet_accounts").byId(1).balance, 7);
  assert.equal(conserved(), CAP);
  const t2 = await K.createTask({ title: "x", type: "other", reward: 2 });
  await K.claimTask(2, t2._id);
  assert.equal(await K.reviewClaim(`${t2._id}:2`, false, 900), "rejected");
  assert.equal((await K.claimTask(2, t2._id)).status, "pending");
});

test("wallet->wallet: quote pins everything, confirm moves amount+fee once, idempotent, conservation holds", async () => {
  await fund(1, 100);
  await C.getOrCreateAccount(2);
  await C.updateSettings({ feeWallet: { pct: 5, fixed: 1 } });
  const res = await T.resolveDestination(1, { dest: "wallet", token: tok(2) });
  assert.equal(res.displayName, "N2");
  assert.ok(!("targetUserId" in res));
  const q = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 20 });
  assert.equal(q.fee, 2); // ceil(5% of 20)=1 + fixed 1
  assert.equal(q.total, 22);
  const a = await T.confirmQuote(1, q.intentId);
  assert.equal(a.status, "completed");
  assert.equal(a.newBalance, 78);
  const b = await T.confirmQuote(1, q.intentId);
  assert.equal(b.duplicate, true);
  assert.equal(col("wallet_accounts").byId(1).balance, 78);
  assert.equal(col("wallet_accounts").byId(2).balance, 20);
  assert.equal(col("wallet_supply").byId("supply").feesCollected, 2);
  assert.equal(conserved(), CAP);
  const h = await T.listHistory(2);
  assert.equal(h.items[0]!.amount, 20);
  assert.equal(h.items[0]!.kind, "transfer_in");
  const h1 = await T.listHistory(1);
  assert.equal(h1.items[0]!.amount, -22);
});

test("transfer safety: self, bad token, insufficient, limits, banned, foreign/expired/cancelled intents", async () => {
  await fund(1, 10);
  await C.getOrCreateAccount(2);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(1), amount: 1 }), /self_transfer/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: "RLC-AAAA-AAAA-AAAA-AAAA", amount: 1 }), /target_not_found/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: "nonsense", amount: 1 }), /invalid_token/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: 11 }), /insufficient_balance/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: 1.5 as any }), /invalid_amount/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: "5" as any }), /invalid_amount/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: -5 }), /invalid_amount/);
  await C.updateSettings({ transferMin: 2, transferMax: 8 });
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: 1 }), /below_min/);
  await assert.rejects(T.createQuote(1, { dest: "wallet", token: tok(2), amount: 9 }), /above_max/);

  const q = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 5 });
  await assert.rejects(T.confirmQuote(3, q.intentId), /intent|not_found|intent_expired/); // someone else's intent
  assert.equal(col("wallet_accounts").byId(1).balance, 10);
  await T.cancelQuote(1, q.intentId);
  await assert.rejects(T.confirmQuote(1, q.intentId), /intent_not_found/);
  const q2 = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 5 });
  await set("wallet_intents", q2.intentId, { expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(T.confirmQuote(1, q2.intentId), /intent_expired/);
  const q3 = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 5 });
  await set("users", 1, { banned: true });
  await assert.rejects(T.confirmQuote(1, q3.intentId), /banned/);
  assert.equal(col("wallet_accounts").byId(1).balance, 10);
  assert.equal(conserved(), CAP);
});

test("double-spend: two quotes that together exceed the balance -> only one confirm succeeds; concurrent confirm of one quote pays once", async () => {
  await fund(1, 10);
  await C.getOrCreateAccount(2);
  const a = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 8 });
  const b = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 8 });
  const rs = await Promise.allSettled([T.confirmQuote(1, a.intentId), T.confirmQuote(1, b.intentId)]);
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(col("wallet_accounts").byId(1).balance, 2);
  assert.equal(col("wallet_accounts").byId(2).balance, 8);
  const c = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 2 });
  const same = await Promise.allSettled([T.confirmQuote(1, c.intentId), T.confirmQuote(1, c.intentId), T.confirmQuote(1, c.intentId)]);
  assert.ok(same.every((r) => r.status === "fulfilled"));
  assert.equal(col("wallet_accounts").byId(1).balance, 0);
  assert.equal(col("wallet_accounts").byId(2).balance, 10);
  assert.equal(col("wallet_ledger").all().filter((l: any) => l.kind === "transfer").length, 2);
  assert.equal(conserved(), CAP);
});

test("wallet->Nava: credits the Nava balance with a Nava ledger row; fee kept; atomic", async () => {
  await fund(1, 50);
  await C.updateSettings({ feeNava: { pct: 0, fixed: 2 } });
  const r = await T.resolveDestination(1, { dest: "nava", token: "user_AAA2" });
  assert.equal(r.displayName, "N2");
  const q = await T.createQuote(1, { dest: "nava", token: "user_AAA2", amount: 10 });
  await T.confirmQuote(1, q.intentId);
  assert.equal(col("wallet_accounts").byId(1).balance, 38);
  assert.equal(col("users").byId(2).relicBalance, 10);
  assert.equal(col("relic_transactions").all().filter((t: any) => t.type === "WALLET_TRANSFER_IN").length, 1);
  await T.confirmQuote(1, q.intentId);
  assert.equal(col("users").byId(2).relicBalance, 10, "replay does not credit twice");
  assert.equal(conserved(), CAP);
  await assert.rejects(T.createQuote(1, { dest: "nava", token: "user_AAA1", amount: 1 }), /self_transfer/);
  await assert.rejects(T.createQuote(1, { dest: "nava", token: "user_ZZZZ", amount: 1 }), /target_not_found/);
});

test("enumeration guard: resolving unknown tokens is capped", async () => {
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) {
    try { await T.resolveDestination(1, { dest: "wallet", token: "RLC-AAAA-AAAA-AAAA-AAA" + (i % 9 + 2) }); }
    catch (e: any) { if (e.code === "rate_limited") limited = true; }
  }
  assert.equal(limited, true);
});

async function mkPartner(canIssue = false) {
  const created = await P.createPartner({ id: "dl", name: "Downloader", baseUrl: "https://dl.example/api/relic", canIssue });
  return created;
}

test("partner: wallet->partner success, definitive refusal refunds, network failure stays pending then retries", async () => {
  await mkPartner();
  await fund(1, 100);
  const calls: any[] = [];
  let mode: "ok" | "refuse" | "down" = "ok";
  P.setPartnerFetcher(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (mode === "down") throw new Error("net");
    if (url.endsWith("/resolve")) return { status: 200, json: async () => ({ ok: true, displayName: "DLUser" }) };
    if (mode === "refuse") return { status: 200, json: async () => ({ ok: false, code: "unknown_token" }) };
    return { status: 200, json: async () => ({ ok: true }) };
  });

  const q = await T.createQuote(1, { dest: "partner", partnerId: "dl", token: "abc123", amount: 30 });
  assert.equal(q.dest.displayName, "DLUser");
  const ok = await T.confirmQuote(1, q.intentId);
  assert.equal(ok.status, "completed");
  assert.equal(col("wallet_partners").byId("dl").balance, 30);
  const rec = calls.find((c) => c.url.endsWith("/receive"));
  assert.equal(rec.body.transferId, ok.txId);
  assert.equal(rec.body.amount, 30);
  const secret = col("wallet_partners").byId("dl").webhookSecret;
  assert.equal(P.verifySignature(secret, rec.headers["X-Wallet-Timestamp"], JSON.stringify(rec.body), rec.headers["X-Wallet-Signature"]), true);
  assert.equal(col("wallet_ledger").byId(ok.txId).destToken, undefined, "partner user token dropped after delivery");

  mode = "refuse";
  const q2 = await T.createQuote(1, { dest: "partner", partnerId: "dl", token: "zzz", amount: 10 });
  await assert.rejects(T.confirmQuote(1, q2.intentId), /partner_refused/);
  assert.equal(col("wallet_accounts").byId(1).balance, 70);
  assert.equal(col("wallet_partners").byId("dl").balance, 30);
  assert.equal(col("wallet_ledger").byId(`tx:${q2.intentId}`).status, "refunded");
  assert.equal(conserved(), CAP);
  const rr = col("wallet_ledger").byId(`refund:tx:${q2.intentId}`);
  assert.ok(rr.code && notes.some((n) => n.chat === 1 && n.text.includes(rr.code) && n.text.includes(col("wallet_ledger").byId(`tx:${q2.intentId}`).code)), "sender told about the refund with both codes");

  mode = "down";
  const q3 = await T.createQuote(1, { dest: "partner", partnerId: "dl", token: "abc", amount: 5 }).catch((e) => e);
  assert.equal(q3.code, "partner_unavailable", "cannot even quote while the partner is down");
  mode = "ok";
  const q4 = await T.createQuote(1, { dest: "partner", partnerId: "dl", token: "abc", amount: 5 });
  mode = "down";
  const pend = await T.confirmQuote(1, q4.intentId);
  assert.equal(pend.status, "pending");
  assert.equal(col("wallet_ledger").byId(pend.txId).status, "pending");
  mode = "ok";
  const sweep = await P.retryPendingDeliveries();
  assert.equal(sweep.completed, 1);
  assert.equal(col("wallet_ledger").byId(pend.txId).status, "completed");
  assert.equal((await P.retryPendingDeliveries()).tried, 0);
  assert.equal(conserved(), CAP);
});

test("partner inbound API: auth, resolve, deposit (bounded by float), credit (needs canIssue), idempotent", async () => {
  const { apiKey } = await mkPartner(false);
  await C.getOrCreateAccount(1);
  assert.equal(await P.authenticatePartner(undefined), null);
  assert.equal(await P.authenticatePartner("Bearer wpk_" + "0".repeat(48)), null);
  const p = (await P.authenticatePartner(`Bearer ${apiKey}`))!;
  assert.ok(p);
  const r = await P.handlePartnerRequest(p, { action: "resolve", token: tok(1) });
  assert.equal((r.body as any).displayName, "N1");
  assert.equal((await P.handlePartnerRequest(p, { action: "deposit", token: tok(1), amount: 5, externalId: "e1" })).status, 400, "float is 0");
  await set("wallet_partners", "dl", { balance: 20 });
  await set("wallet_supply", "supply", { remaining: CAP - 20 });
  const d1 = await P.handlePartnerRequest(p, { action: "deposit", token: tok(1), amount: 15, externalId: "e2" });
  assert.equal((d1.body as any).walletBalance, 15);
  const d2 = await P.handlePartnerRequest(p, { action: "deposit", token: tok(1), amount: 15, externalId: "e2" });
  assert.equal((d2.body as any).duplicate, true);
  assert.equal(col("wallet_accounts").byId(1).balance, 15);
  assert.equal(col("wallet_partners").byId("dl").balance, 5);
  assert.equal((await P.handlePartnerRequest(p, { action: "credit", token: tok(1), amount: 5, externalId: "c1" })).status, 403);
  await set("wallet_partners", "dl", { canIssue: true });
  const pi = (await P.authenticatePartner(`Bearer ${apiKey}`))!;
  const c1 = await P.handlePartnerRequest(pi, { action: "credit", token: tok(1), amount: 5, externalId: "c1" });
  assert.equal(c1.status, 200);
  await P.handlePartnerRequest(pi, { action: "credit", token: tok(1), amount: 5, externalId: "c1" });
  assert.equal(col("wallet_accounts").byId(1).balance, 20);
  assert.equal((await P.handlePartnerRequest(pi, { action: "deposit", token: "bad", amount: 1, externalId: "x" })).status, 400);
  assert.equal((await P.handlePartnerRequest(pi, { action: "deposit", token: tok(1), amount: 1.5, externalId: "x" })).status, 400);
  assert.equal(conserved(), CAP);
  await P.setPartnerActive("dl", false);
  assert.equal(await P.authenticatePartner(`Bearer ${apiKey}`), null);
});

test("tx log: every ledger row is posted once to the channel; unset channel posts nothing; failed send retries", async () => {
  const sent: string[] = [];
  let fail = false;
  L.setTxSender(async (_c, text) => { if (fail) throw new Error("tg"); sent.push(text); });
  await fund(1, 50);
  await C.getOrCreateAccount(2);
  const q = await T.createQuote(1, { dest: "wallet", token: tok(2), amount: 5 });
  await T.confirmQuote(1, q.intentId);
  assert.equal(await L.flushTxLog(), 0, "no channel configured");
  await C.updateSettings({ txLogChatId: -100123, txLogSince: new Date(0) });
  fail = true;
  assert.equal(await L.flushTxLog(), 0);
  fail = false;
  assert.equal(await L.flushTxLog(), 1);
  assert.equal(await L.flushTxLog(), 0, "not posted twice");
  assert.match(sent[0]!, /مقدار: 5/);
  assert.match(sent[0]!, /N1/);
  assert.match(sent[0]!, /N2/);
  assert.match(sent[0]!, /موفق/);
});

test("signup bonus: granted once from the supply when configured", async () => {
  await C.updateSettings({ signupBonus: 4 });
  await Promise.all([C.getOrCreateAccount(1), C.getOrCreateAccount(1)]);
  assert.equal(col("wallet_accounts").byId(1).balance, 4);
  assert.equal(col("wallet_ledger").all().filter((l: any) => l.kind === "signup_bonus").length, 1);
  assert.equal(conserved(), CAP);
});

test("first use after deploy: the supply singleton is created lazily (default cap) and rewards work", async () => {
  resetFakeMongo();
  for (const id of [1]) seedUser({ id, nickname: "N1", anonId: "user_AAA1" });
  const t = await K.createTask({ title: "x", type: "other", reward: 3 });
  K.setReviewNotifier(async () => {});
  await K.claimTask(1, t._id);
  assert.equal(await K.reviewClaim(`${t._id}:1`, true, 900), "approved");
  const s = col("wallet_supply").byId("supply");
  assert.equal(s.cap, 21_000_000);
  assert.equal(s.remaining, 21_000_000 - 3);
});
