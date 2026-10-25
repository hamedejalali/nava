/** Defect C: Telegram Stars fulfilment is driven by the ORIGINAL order, validated and idempotent. */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const U = 7001;
let uid = 880000;
beforeEach(() => {
  resetState();
  h.resetCalls();
  h.clearFailures();
  seedUser({ id: U, nickname: "x", languageCode: "fa", relicBalance: 10, relicInitialized: true });
});

const setPackages = (packages: { price: number; relic: number }[]) =>
  col("relic_pricing").replaceOne({ _id: "stars" }, { _id: "stars", packages, updatedAt: new Date() }, { upsert: true });
const from = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

async function buy(index: number, user = U): Promise<string> {
  h.resetCalls();
  await h.callback(user, `shop:b:p${index}`);
  const inv = h.of("sendInvoice", user).at(-1);
  assert.ok(inv, "invoice sent");
  return inv!.payload.payload as string;
}
async function preCheckout(payload: string, amount: number, currency = "XTR", user = U) {
  h.resetCalls();
  await h.bot.handleUpdate({ update_id: ++uid, pre_checkout_query: { id: `q${uid}`, from: from(user), currency, total_amount: amount, invoice_payload: payload } });
  return h.of("answerPreCheckoutQuery").at(-1)!.payload;
}
async function pay(payload: string, amount: number, charge: string, opts: { currency?: string; user?: number } = {}) {
  const user = opts.user ?? U;
  h.resetCalls();
  await h.bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: uid, date: Math.floor(Date.now() / 1000), chat: { id: user, type: "private", first_name: "x" }, from: from(user),
      successful_payment: { currency: opts.currency ?? "XTR", total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: "" },
    },
  });
  await h.settle();
}
const balance = (id = U) => col("users").byId(id).relicBalance;
const ledger = (id = U) => col("relic_transactions").all().filter((t: any) => t.userId === id && t.type === "PURCHASE");

test("C1. normal purchase credits the order's Relic exactly once; Telegram retries do not double-credit", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  assert.match(p, /^relic:o:/);
  assert.equal((await preCheckout(p, 50)).ok, true);
  await pay(p, 50, "CH1");
  await pay(p, 50, "CH1");
  await Promise.all([pay(p, 50, "CH1"), pay(p, 50, "CH1")]);
  assert.equal(balance(), 20);
  assert.equal(ledger().length, 1);
  assert.equal(col("stars_orders").all()[0].status, "fulfilled");
});

test("C2. REGRESSION: admin changes/removes the package AFTER the invoice -> the payment is still fulfilled from the original order", async () => {
  await setPackages([{ price: 50, relic: 10 }, { price: 100, relic: 25 }]);
  const p = await buy(1); // 100 Stars = 25 Relic
  await setPackages([{ price: 100, relic: 12 }]); // index 1 gone, index 0 re-priced
  assert.equal((await preCheckout(p, 100)).ok, true, "an already issued invoice stays payable");
  await pay(p, 100, "CH2");
  assert.equal(balance(), 35, "credited the 25 Relic that were promised, not the new config");
  await setPackages([{ price: 100, relic: 12 }, { price: 999, relic: 1 }]); // index 1 now a different package
  await pay(p, 100, "CH2"); // late duplicate
  assert.equal(balance(), 35);
});

test("C3. wrong amount / wrong currency / unknown order / garbage payload are NOT credited and are recorded for review", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  assert.equal((await preCheckout(p, 49)).ok, false);
  assert.equal((await preCheckout(p, 50, "USD")).ok, false);
  assert.equal((await preCheckout("relic:o:doesnotexist1", 50)).ok, false);
  assert.equal((await preCheckout("evil", 50)).ok, false);

  await pay(p, 1, "BAD1");
  await pay(p, 50, "BAD2", { currency: "USD" });
  await pay("relic:o:doesnotexist1", 50, "BAD3");
  await pay("evil", 50, "BAD4");
  assert.ok(h.of("sendMessage", OWNER_ID).some((c) => /BAD4/.test(String(c.payload.text))), "owner is told so the payment can be refunded");
  await pay(p, 50, "");
  assert.equal(balance(), 10);
  assert.equal(ledger().length, 0);
  const ex = col("stars_payment_exceptions").all().map((e: any) => e._id).sort();
  assert.deepEqual(ex, ["BAD1", "BAD2", "BAD3", "BAD4"]);
  // the same bad payment redelivered is recorded and announced once
  h.resetCalls();
  await pay("evil", 50, "BAD4");
  assert.equal(h.of("sendMessage", OWNER_ID).length, 0);
});

test("C4. legacy payloads (invoice issued by the previous version: relic:<index>) still work against the live package", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  assert.equal((await preCheckout("relic:0", 50)).ok, true);
  assert.equal((await preCheckout("relic:0", 51)).ok, false);
  await pay("relic:0", 50, "LEG1");
  assert.equal(balance(), 20);
  await pay("relic:0", 50, "LEG1");
  assert.equal(balance(), 20);
});

test("C5. DB failure in the middle of fulfilment: the update fails (Telegram retries) and the retry credits exactly once", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  const orig = (await import("../../src/db/connect.js")).getClient;
  const client: any = await orig();
  const realStart = client.startSession.bind(client);
  let boom = true;
  client.startSession = (...a: any[]) => {
    const s = realStart(...a);
    const wt = s.withTransaction.bind(s);
    s.withTransaction = async (fn: any, o: any) => {
      if (boom) { boom = false; throw new Error("simulated Mongo outage"); }
      return wt(fn, o);
    };
    return s;
  };
  try {
    await assert.rejects(h.bot.handleUpdate({ update_id: ++uid, message: { message_id: 1, date: 1, chat: { id: U, type: "private" }, from: from(U), successful_payment: { currency: "XTR", total_amount: 50, invoice_payload: p, telegram_payment_charge_id: "RETRY1", provider_payment_charge_id: "" } } }));
    assert.equal(balance(), 10);
    assert.equal(ledger().length, 0);
    assert.equal(col("stars_orders").all()[0].status, "pending", "not marked fulfilled before it was credited");
  } finally {
    client.startSession = realStart;
  }
  await pay(p, 50, "RETRY1"); // Telegram's redelivery
  assert.equal(balance(), 20);
  assert.equal(ledger().length, 1);
  assert.equal(col("stars_orders").all()[0].status, "fulfilled");
});

test("C6. order is credited to the user who actually paid (a forwarded invoice cannot credit someone else)", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  seedUser({ id: 7002, nickname: "y", languageCode: "fa", relicBalance: 0, relicInitialized: true });
  const p = await buy(0);
  await pay(p, 50, "FWD1", { user: 7002 });
  assert.equal(balance(7002), 10);
  assert.equal(balance(U), 10);
});

test("C7. repeated taps on the same package reuse one open order (no document pile-up); a re-priced package gets a new order", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p1 = await buy(0), p2 = await buy(0), p3 = await buy(0);
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  assert.equal(col("stars_orders").all().length, 1);
  await setPackages([{ price: 60, relic: 10 }]);
  const p4 = await buy(0);
  assert.notEqual(p4, p1);
  assert.equal(h.of("sendInvoice", U).at(-1)!.payload.prices[0].amount, 60);
});

test("S1. transfer to a recipient that does not exist rolls the sender's debit back (no vanished Relic, no orphan ledger row)", async () => {
  const { transferRelicOnce } = await import("../../src/db/models/relic.js");
  const r = await transferRelicOnce("t-missing-1", U, 999999, 3);
  assert.equal(r.status, "invalid");
  assert.equal(balance(), 10);
  assert.equal(col("relic_transactions").all().filter((t: any) => t._id.startsWith("transfer:t-missing-1")).length, 0);
  seedUser({ id: 7003, nickname: "z", languageCode: "fa", relicBalance: 0, relicInitialized: true });
  assert.equal((await transferRelicOnce("t-ok-1", U, 7003, 3)).status, "completed");
  assert.equal((await transferRelicOnce("t-ok-1", U, 7003, 3)).status, "already_processed");
  assert.equal(balance(), 7);
  assert.equal(balance(7003), 3);
});
