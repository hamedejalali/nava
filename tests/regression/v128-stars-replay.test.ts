/** v1.28.0 — Stars: one order = one credit; banned / maintenance payers still get their payment processed. */
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


const exceptions = () => col("stars_payment_exceptions").all();

test("P1. a DIFFERENT charge cannot consume an already fulfilled order; real payment kept for reconciliation; pre-checkout refuses it", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  await pay(p, 50, "CHA");
  assert.equal(balance(), 20);
  assert.equal((await preCheckout(p, 50)).ok, false, "a paid order is no longer payable");
  await pay(p, 50, "CHB"); // Telegram already took the money (e.g. two pre-checkouts raced)
  assert.equal(balance(), 20, "no second credit");
  assert.equal(ledger().length, 1);
  assert.equal(exceptions().length, 1);
  assert.equal(exceptions()[0]._id, "CHB");
  assert.equal(exceptions()[0].reason, "order_already_fulfilled");
  await pay(p, 50, "CHB"); // retry of the exception itself: still one record
  assert.equal(exceptions().length, 1);
  assert.equal(col("stars_orders").all()[0].chargeId, "CHA");
});

test("P2. concurrent payments for one order with different charges: exactly one credit", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  await Promise.all([pay(p, 50, "C1"), pay(p, 50, "C2"), pay(p, 50, "C3")]);
  assert.equal(balance(), 20);
  assert.equal(ledger().length, 1);
  assert.equal(exceptions().length, 2);
});

test("P3. forwarded invoice: the first valid payer gets the credit (not the invoice owner); a second payer gets nothing", async () => {
  const V = 7002;
  seedUser({ id: V, nickname: "friend", languageCode: "fa", relicBalance: 0, relicInitialized: true });
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  await pay(p, 50, "FW1", { user: V });
  assert.equal(balance(V), 10);
  assert.equal(balance(), 10, "the invoice owner did not pay");
  await pay(p, 50, "FW2", { user: 7001 });
  assert.equal(balance(), 10);
  assert.equal(col("stars_orders").all()[0].payerId, V);
});

test("P4. a BANNED payer's successful payment is still credited; ordinary features stay blocked; pre-checkout still answered", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  col("users").byId(U).banned = true;
  assert.equal((await preCheckout(p, 50)).ok, true);
  await pay(p, 50, "BAN1");
  assert.equal(balance(), 20);
  h.resetCalls();
  await h.text(U, "سلام");
  await h.settle();
  assert.ok(h.of("sendMessage", U).length >= 1 && h.of("sendMessage", U).every((c) => !c.payload.reply_markup?.keyboard), "only the ban notice, never the menu");
  assert.equal(balance(), 20);
});

test("P5. maintenance mode does not stop a payment that Telegram already accepted", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  await col("bot_settings").updateOne({ _id: "singleton" }, { $set: { maintenanceMode: true } }, { upsert: true });
  assert.equal((await preCheckout(p, 50)).ok, true);
  await pay(p, 50, "MT1");
  assert.equal(balance(), 20);
});

test("P6. redelivery of an already fulfilled payment is idempotent (a real DB-failure rollback cannot be simulated by the fake Mongo — see the report)", async () => {
  await setPackages([{ price: 50, relic: 10 }]);
  const p = await buy(0);
  await pay(p, 50, "DB1");
  await pay(p, 50, "DB1");
  assert.equal(balance(), 20);
  assert.equal(col("stars_orders").all()[0].status, "fulfilled");
  assert.equal(exceptions().length, 0, "a plain retry is not an exception");
});
