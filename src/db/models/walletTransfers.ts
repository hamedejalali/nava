import { notifyTx } from "../../services/walletNotify.js";
import { getDb } from "../connect.js";
import type { UserDoc } from "./user.js";
import {
  INTENT_TTL_MS, WalletError, accounts, computeFee, displayNameOf, getOrCreateAccount, getSettings, insertLedger, ledgerCol,
  newIntentId, resolveLocalDest, runTx, supplyCol, takeRate, type DestInfo, type WalletLedgerDoc,
} from "./walletCore.js";
import { deliverToPartner, getPartner, partnersCol, resolvePartnerDest } from "./walletPartners.js";

export interface IntentDoc {
  _id: string;
  senderId: number;
  dest: { kind: DestInfo["kind"]; partnerId?: string; targetUserId?: number; displayName: string; tokenMasked: string; rawToken?: string };
  amount: number;
  fee: number;
  status: "pending" | "done" | "cancelled";
  txId?: string;
  createdAt: Date;
  expiresAt: Date;
}
async function intents() {
  return (await getDb()).collection<IntentDoc>("wallet_intents");
}

type DestKind = "wallet" | "nava" | "partner";
function parseKind(v: unknown): DestKind {
  if (v === "wallet" || v === "nava" || v === "partner") return v;
  throw new WalletError("invalid_token");
}

async function senderGuard(senderId: number): Promise<UserDoc> {
  const u = await (await getDb()).collection<UserDoc>("users").findOne({ _id: senderId });
  if (!u) throw new WalletError("not_found", 404);
  if (u.banned) throw new WalletError("banned", 403);
  return u;
}

/** Step 1 — "who owns this token?" Rate-limited so tokens can't be enumerated. */
export async function resolveDestination(senderId: number, bodyIn: { dest?: unknown; partnerId?: unknown; token?: unknown }): Promise<Omit<DestInfo, "targetUserId">> {
  await senderGuard(senderId);
  if (!(await takeRate(senderId, "resolve", 30, 10 * 60_000))) throw new WalletError("rate_limited", 429);
  const kind = parseKind(bodyIn.dest);
  try {
    const d = kind === "partner" ? await resolvePartnerDest(bodyIn.partnerId, bodyIn.token) : await resolveLocalDest(kind, bodyIn.token, senderId);
    const { targetUserId: _t, ...pub } = d;
    return pub;
  } catch (err) {
    // failed lookups burn a much smaller budget: 12 misses/hour
    if (err instanceof WalletError && (err.code === "target_not_found" || err.code === "invalid_token")) {
      if (!(await takeRate(senderId, "resolve_miss", 12, 3600_000))) throw new WalletError("rate_limited", 429);
    }
    throw err;
  }
}

function feeRuleFor(kind: DestKind, s: Awaited<ReturnType<typeof getSettings>>, partner?: { fee: { pct: number; fixed: number } } | null) {
  if (kind === "wallet") return s.feeWallet;
  if (kind === "nava") return s.feeNava;
  return partner?.fee ?? { pct: 0, fixed: 0 };
}

/** Step 2 — server-side quote. The intent pins destination, amount and fee; the client can change none of it. */
export async function createQuote(senderId: number, bodyIn: { dest?: unknown; partnerId?: unknown; token?: unknown; amount?: unknown }) {
  await senderGuard(senderId);
  if (!(await takeRate(senderId, "quote", 20, 10 * 60_000))) throw new WalletError("rate_limited", 429);
  const amount = bodyIn.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) throw new WalletError("invalid_amount");
  const settings = await getSettings();
  if (amount < settings.transferMin) throw new WalletError("below_min");
  if (amount > settings.transferMax) throw new WalletError("above_max");

  const kind = parseKind(bodyIn.dest);
  const dest = kind === "partner" ? await resolvePartnerDest(bodyIn.partnerId, bodyIn.token) : await resolveLocalDest(kind, bodyIn.token, senderId);
  const partner = kind === "partner" ? await getPartner(dest.partnerId!) : null;
  const fee = computeFee(amount, feeRuleFor(kind, settings, partner));

  const acct = await getOrCreateAccount(senderId);
  if (acct.balance < amount + fee) throw new WalletError("insufficient_balance");
  if (kind === "wallet") await getOrCreateAccount(dest.targetUserId!);

  const now = new Date();
  const intent: IntentDoc = {
    _id: newIntentId(), senderId,
    dest: { kind, partnerId: dest.partnerId, targetUserId: dest.targetUserId, displayName: dest.displayName, tokenMasked: dest.tokenMasked, rawToken: kind === "partner" && typeof bodyIn.token === "string" ? bodyIn.token.trim() : undefined },
    amount, fee, status: "pending", createdAt: now, expiresAt: new Date(now.getTime() + INTENT_TTL_MS),
  };
  await (await intents()).insertOne(intent);
  return {
    intentId: intent._id, expiresAt: intent.expiresAt.toISOString(),
    dest: { kind, partnerId: dest.partnerId, displayName: dest.displayName, tokenMasked: dest.tokenMasked },
    amount, fee, total: amount + fee,
  };
}

export async function cancelQuote(senderId: number, intentId: unknown): Promise<{ status: "cancelled" }> {
  if (typeof intentId !== "string") throw new WalletError("intent_not_found", 404);
  const r = await (await intents()).updateOne({ _id: intentId, senderId, status: "pending" }, { $set: { status: "cancelled" } });
  if (r.matchedCount !== 1) {
    const cur = await (await intents()).findOne({ _id: intentId, senderId });
    if (!cur) throw new WalletError("intent_not_found", 404);
    if (cur.status === "done") throw new WalletError("already_done");
  }
  return { status: "cancelled" };
}

export interface ConfirmResult { status: "completed" | "pending"; txId: string; code: string | null; newBalance: number; duplicate: boolean }

/** Step 3 — execute. Idempotent: repeating with the same intentId returns the same result and moves nothing twice. */
export async function confirmQuote(senderId: number, intentId: unknown): Promise<ConfirmResult> {
  if (typeof intentId !== "string" || intentId.length > 64) throw new WalletError("intent_not_found", 404);
  await senderGuard(senderId);
  const txId = `tx:${intentId}`;
  const ints = await intents();

  const replay = async (): Promise<ConfirmResult | null> => {
    const row = await (await ledgerCol()).findOne({ _id: txId });
    if (!row || row.fromUser !== senderId) return null;
    const acct = await getOrCreateAccount(senderId);
    return { status: row.status === "completed" ? "completed" : "pending", txId, code: row.code ?? null, newBalance: acct.balance, duplicate: true };
  };

  const done = await replay();
  if (done) return done;

  let ledgerRow!: WalletLedgerDoc;
  try {
    await runTx(async (session) => {
      const now = new Date();
      const it = await ints.findOneAndUpdate(
        { _id: intentId, senderId, status: "pending", expiresAt: { $gt: now } },
        { $set: { status: "done", txId } },
        { returnDocument: "after", session },
      );
      if (!it) throw new WalletError("intent_gone");
      const total = it.amount + it.fee;
      const users = (await getDb()).collection<UserDoc>("users");
      const sender = await users.findOne({ _id: senderId }, { session });
      if (!sender || sender.banned) throw new WalletError("banned", 403);

      const debit = await (await accounts()).updateOne({ _id: senderId, balance: { $gte: total } }, { $inc: { balance: -total } }, { session });
      if (debit.matchedCount !== 1) throw new WalletError("insufficient_balance");

      const base = { _id: txId, amount: it.amount, fee: it.fee, fromUser: senderId, from: `wallet:${senderId}`, fromName: displayNameOf(sender), toName: it.dest.displayName };
      const addFee = async () => {
        if (it.fee > 0) await (await supplyCol()).updateOne({ _id: "supply" }, { $inc: { feesCollected: it.fee } }, { session });
      };

      if (it.dest.kind === "wallet") {
        const target = await users.findOne({ _id: it.dest.targetUserId! }, { session });
        if (!target || target.banned) throw new WalletError("target_not_found", 404);
        const r = await (await accounts()).updateOne({ _id: target._id }, { $inc: { balance: it.amount } }, { session });
        if (r.matchedCount !== 1) throw new WalletError("target_not_found", 404);
        await addFee();
        ledgerRow = await insertLedger({ ...base, kind: "transfer", toUser: target._id, to: `wallet:${target._id}` }, session);
      } else if (it.dest.kind === "nava") {
        const target = await users.findOne({ _id: it.dest.targetUserId! }, { session });
        if (!target || target.banned || target.onboardingStep !== "COMPLETED") throw new WalletError("target_not_found", 404);
        await users.updateOne({ _id: target._id }, { $inc: { relicBalance: it.amount } } as any, { session });
        await (await getDb()).collection<any>("relic_transactions").insertOne({
          _id: `walletin:${txId}`, userId: target._id, counterpartyUserId: senderId, amount: it.amount, type: "WALLET_TRANSFER_IN",
          status: "completed", reference: txId, sourceApp: "wallet", createdAt: now, completedAt: now,
        }, { session });
        await addFee();
        ledgerRow = await insertLedger({ ...base, kind: "to_nava", toUser: target._id, to: `nava:${target._id}` }, session);
      } else {
        const p = await getPartner(it.dest.partnerId!);
        if (!p || !p.active) throw new WalletError("partner_unavailable", 503);
        await (await partnersCol()).updateOne({ _id: p._id }, { $inc: { balance: it.amount } }, { session });
        await addFee();
        ledgerRow = await insertLedger({ ...base, kind: "to_partner", toUser: null, to: `partner:${p._id}`, toName: `${p.name} · ${it.dest.displayName}`, partnerId: p._id, status: "pending", attempts: 0, destToken: it.dest.rawToken } as any, session);
      }
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const again = await replay();
      if (again) return again;
    }
    if (err instanceof WalletError && err.code === "intent_gone") {
      const again = await replay();
      if (again) return again;
      const cur = await ints.findOne({ _id: intentId, senderId });
      if (!cur) throw new WalletError("intent_not_found", 404);
      if (cur.status === "done") {
        // a concurrent confirm of the SAME intent is finishing: wait briefly and return its result
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const late = await replay();
          if (late) return late;
        }
        throw new WalletError("pending_elsewhere", 409);
      }
      throw new WalletError(cur.status === "cancelled" ? "intent_not_found" : "intent_expired", 410);
    }
    throw err;
  }

  let status: "completed" | "pending" = ledgerRow.status === "completed" ? "completed" : "pending";
  if (ledgerRow.kind === "to_partner") {
    const s = await deliverToPartner(ledgerRow._id).catch(() => "pending" as const);
    status = s === "completed" ? "completed" : "pending";
    if (s === "refunded") throw new WalletError("partner_refused", 409);
  }
  const acct = await getOrCreateAccount(senderId);
  await notifyTx(txId).catch(() => {});
  return { status, txId, code: ledgerRow.code ?? null, newBalance: acct.balance, duplicate: false };
}

// ---------------------------------------------------------------- history
export interface HistoryItem {
  id: string; code: string | null; kind: string; amount: number; fee: number; counterparty: string | null; status: string; createdAt: string;
}
export function viewOf(row: WalletLedgerDoc, userId: number): HistoryItem {
  const outgoing = row.fromUser === userId;
  let kind: string = row.kind;
  if (row.kind === "transfer") kind = outgoing ? "transfer_out" : "transfer_in";
  else if (row.kind === "recovery") kind = outgoing ? "recovery_out" : "recovery_in";
  const signed = outgoing ? -(row.amount + (row.status === "refunded" ? 0 : row.fee)) : row.amount;
  return {
    id: row._id, code: row.code ?? null, kind, amount: signed, fee: outgoing ? row.fee : 0,
    counterparty: (outgoing ? row.toName : row.fromName) ?? null,
    status: row.status === "failed" ? "failed" : row.status, createdAt: row.createdAt.toISOString(),
  };
}
export async function listHistory(userId: number, cursor?: unknown, limit = 20) {
  const filter: any = { $or: [{ fromUser: userId }, { toUser: userId }] };
  if (typeof cursor === "string" && /^\d{10,15}$/.test(cursor)) filter.createdAt = { $lt: new Date(Number(cursor)) };
  const rows = await (await ledgerCol()).find(filter).sort({ createdAt: -1 }).limit(limit + 1).toArray();
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => viewOf(r, userId)),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.createdAt.getTime()) : null,
  };
}
