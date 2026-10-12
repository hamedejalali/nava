import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";

/**
 * A Telegram Stars purchase "order": the package (price + Relic) the user was actually OFFERED when the
 * invoice was created. Fulfilment always credits from this record, never from the package list as it
 * happens to look when the payment arrives, so an admin changing prices (or Telegram delivering the
 * payment late/retried) can never turn a real payment into a lost or wrongly valued one.
 */
export interface StarsOrderDoc {
  _id: string;
  userId: number;
  packageIndex: number;
  price: number; // Stars charged
  relic: number; // Relic promised
  currency: "XTR";
  status: "pending" | "fulfilled";
  createdAt: Date;
  fulfilledAt?: Date;
  chargeId?: string;
}

/** Payments that could not be matched to an order / failed validation. Kept for manual reconciliation. */
export interface StarsPaymentExceptionDoc {
  _id: string; // telegram_payment_charge_id
  userId: number;
  amount: number;
  currency: string;
  reason: string;
  orderId?: string;
  createdAt: Date;
}

async function orders() {
  return (await getDb()).collection<StarsOrderDoc>("stars_orders");
}

export async function ensureStarsOrderIndexes(): Promise<void> {
  const c = await orders();
  await c.createIndexes([{ key: { userId: 1, status: 1, createdAt: -1 }, name: "user_status_created" }]);
}

/** Reuses the user's open order for the same package/price/relic (so repeated taps do not pile up
 *  documents) and creates a new one whenever the live package differs from the old order. */
export async function getOrCreateStarsOrder(userId: number, packageIndex: number, pkg: { price: number; relic: number }): Promise<StarsOrderDoc> {
  const c = await orders();
  const existing = await c.findOne({ userId, packageIndex, price: pkg.price, relic: pkg.relic, status: "pending" });
  if (existing) return existing;
  const doc: StarsOrderDoc = {
    _id: randomBytes(9).toString("base64url"),
    userId,
    packageIndex,
    price: pkg.price,
    relic: pkg.relic,
    currency: "XTR",
    status: "pending",
    createdAt: new Date(),
  };
  await c.insertOne(doc);
  return doc;
}

export async function getStarsOrder(id: string): Promise<StarsOrderDoc | null> {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  const c = await orders();
  return c.findOne({ _id: id });
}

export async function markStarsOrderFulfilled(id: string, chargeId: string): Promise<void> {
  const c = await orders();
  await c.updateOne({ _id: id }, { $set: { status: "fulfilled", fulfilledAt: new Date(), chargeId } });
}

/** Idempotent (keyed by the Telegram charge id): returns true only the first time it is recorded. */
export async function recordStarsPaymentException(doc: Omit<StarsPaymentExceptionDoc, "createdAt">): Promise<boolean> {
  const c = (await getDb()).collection<StarsPaymentExceptionDoc>("stars_payment_exceptions");
  const r = await c.updateOne({ _id: doc._id }, { $setOnInsert: { ...doc, createdAt: new Date() } }, { upsert: true });
  return r.upsertedCount === 1;
}
