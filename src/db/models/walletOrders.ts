import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";
import { WalletError, accounts, displayNameOf, getOrCreateAccount, getSettings, insertLedger, issueFromSupply, runTx, takeRate } from "./walletCore.js";
import type { UserDoc } from "./user.js";
import { notifyTx } from "../../services/walletNotify.js";

/**
 * Buying Relic inside the wallet bot. The OWNER defines packages and the payment text in the admin panel (DB).
 * The buyer picks a package, pays outside the bot, sends the receipt; the owner approves -> the Relic is issued from
 * the finite supply into the buyer's wallet in ONE transaction (guarded status flip + ledger row = exactly once).
 */
export type OrderStatus = "awaiting_receipt" | "submitted" | "approved" | "rejected" | "cancelled";
export interface WalletOrderDoc {
  _id: string;
  userId: number;
  relic: number;
  priceToman: number;
  status: OrderStatus;
  receiptText?: string;
  receiptFileId?: string;
  reviewedBy?: number;
  ledgerId?: string;
  createdAt: Date;
  updatedAt: Date;
}
const orders = async () => (await getDb()).collection<WalletOrderDoc>("wallet_orders");

export async function createOrder(userId: number, packageIndex: number): Promise<WalletOrderDoc> {
  const s = await getSettings();
  const pk = (s.packages ?? [])[packageIndex];
  if (!pk) throw new WalletError("package_not_found", 404);
  if (!s.texts.buy?.trim()) throw new WalletError("buy_disabled", 503);
  if (!(await takeRate(userId, "buy", 10, 3_600_000))) throw new WalletError("rate_limited", 429);
  const now = new Date();
  const doc: WalletOrderDoc = {
    _id: `ord_${randomBytes(5).toString("hex")}`, userId, relic: pk.relic, priceToman: pk.priceToman, status: "awaiting_receipt", createdAt: now, updatedAt: now,
  };
  await (await orders()).insertOne(doc);
  return doc;
}

export async function getOrder(id: string): Promise<WalletOrderDoc | null> {
  return (await orders()).findOne({ _id: id });
}

/** Buyer sends the receipt (text and/or photo file id). Only the owner of the order, only once per state. */
export async function submitReceipt(orderId: string, userId: number, receipt: { text?: string; fileId?: string }): Promise<WalletOrderDoc> {
  if (!receipt.text?.trim() && !receipt.fileId) throw new WalletError("receipt_empty");
  const set: Partial<WalletOrderDoc> = { status: "submitted", updatedAt: new Date() };
  if (receipt.text) set.receiptText = receipt.text.slice(0, 800);
  if (receipt.fileId) set.receiptFileId = receipt.fileId;
  const o = await (await orders()).findOneAndUpdate({ _id: orderId, userId, status: "awaiting_receipt" }, { $set: set }, { returnDocument: "after" });
  if (!o) throw new WalletError("order_not_open", 409);
  return o;
}

export async function reviewOrder(orderId: string, approve: boolean, adminId: number): Promise<"approved" | "rejected" | "already" | "not_found" | "supply_exhausted"> {
  const col = await orders();
  const cur = await col.findOne({ _id: orderId });
  if (!cur) return "not_found";
  if (cur.status !== "submitted") return "already";
  if (!approve) {
    const r = await col.updateOne({ _id: orderId, status: "submitted" }, { $set: { status: "rejected", reviewedBy: adminId, updatedAt: new Date() } });
    return r.matchedCount === 1 ? "rejected" : "already";
  }
  const ledgerId = `order:${orderId}`;
  await getOrCreateAccount(cur.userId); // outside the transaction (may create the account / grant the signup bonus)
  try {
    await runTx(async (session) => {
      const o = await col.findOneAndUpdate(
        { _id: orderId, status: "submitted" },
        { $set: { status: "approved", reviewedBy: adminId, ledgerId, updatedAt: new Date() } },
        { returnDocument: "after", session },
      );
      if (!o) throw new WalletError("already");
      await issueFromSupply(o.relic, session);
      await (await accounts()).updateOne({ _id: o.userId }, { $inc: { balance: o.relic } }, { session });
      const u = await (await getDb()).collection<UserDoc>("users").findOne({ _id: o.userId }, { session });
      await insertLedger({
        _id: ledgerId, kind: "purchase_credit", amount: o.relic, fromUser: null, toUser: o.userId, from: "supply", to: `wallet:${o.userId}`,
        toName: displayNameOf(u), note: `خرید بسته ${o.relic} رلیک (${o.priceToman} تومان) سفارش ${o._id}`.slice(0, 80),
      }, session);
    });
  } catch (err) {
    if (err instanceof WalletError && err.code === "already") return "already";
    if (err instanceof WalletError && err.code === "supply_exhausted") return "supply_exhausted";
    throw err;
  }
  await notifyTx(ledgerId);
  return "approved";
}
