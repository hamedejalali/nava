import { notifyTx } from "../../services/walletNotify.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../connect.js";
import {
  WalletError, getSettings, insertLedger, issueFromSupply, ledgerCol, runTx, accounts, getAccountByToken, getOrCreateAccount,
  normalizeWalletToken, displayNameOf, type DestInfo, type FeeRule, type WalletLedgerDoc,
} from "./walletCore.js";
import type { UserDoc } from "./user.js";

/**
 * Partners = other bots (e.g. the downloader bot) connected to the wallet.
 *
 *  wallet -> partner : user pays; wallet debits, partner.balance += amount, ledger row
 *                      is "pending" until the partner ACKs `POST {baseUrl}/receive`
 *                      (HMAC-signed, idempotent on transferId). Definitive refusal
 *                      => automatic refund in one transaction. Network trouble =>
 *                      stays pending and is retried (cron / user history / partner
 *                      status endpoint) -- never silently lost.
 *  partner -> wallet : `deposit` (moves value out of the partner's float into a
 *                      wallet; cannot exceed what the wallet sent that partner) and
 *                      `credit` (issues NEW Relic from the supply, e.g. a purchase
 *                      reward; needs canIssue).
 *  Inbound auth: `Authorization: Bearer <apiKey>` (only a SHA-256 hash is stored).
 *  Outbound auth: HMAC-SHA256(webhookSecret, `${timestamp}.${rawBody}`).
 */
export interface PartnerDoc {
  _id: string; // slug
  name: string;
  baseUrl: string; // https://partner.example/api/relic  (we call /resolve and /receive)
  apiKeyHash: string;
  webhookSecret: string;
  fee: FeeRule;
  canIssue: boolean;
  active: boolean;
  balance: number;
  createdAt: Date;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function partnersCol() {
  return (await getDb()).collection<PartnerDoc>("wallet_partners");
}

export async function createPartner(input: { id: string; name: string; baseUrl: string; fee?: FeeRule; canIssue?: boolean }) {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,24}$/.test(id)) throw new WalletError("invalid_partner_id");
  let url: URL;
  try { url = new URL(input.baseUrl.trim()); } catch { throw new WalletError("invalid_url"); }
  if (url.protocol !== "https:") throw new WalletError("invalid_url");
  const apiKey = `wpk_${randomBytes(24).toString("hex")}`;
  const webhookSecret = `wsk_${randomBytes(32).toString("hex")}`;
  try {
    await (await partnersCol()).insertOne({
      _id: id, name: input.name.trim().slice(0, 40), baseUrl: url.toString().replace(/\/+$/, ""), apiKeyHash: sha256(apiKey), webhookSecret,
      fee: input.fee ?? { pct: 0, fixed: 0 }, canIssue: !!input.canIssue, active: true, balance: 0, createdAt: new Date(),
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new WalletError("partner_exists");
    throw err;
  }
  return { id, apiKey, webhookSecret }; // shown to the owner exactly once
}

export async function listPartners(onlyActive = false) {
  const all = await (await partnersCol()).find(onlyActive ? { active: true } : {}).toArray();
  return all;
}
export async function getPartner(id: string) {
  return (await partnersCol()).findOne({ _id: id });
}
export async function setPartnerActive(id: string, active: boolean) {
  await (await partnersCol()).updateOne({ _id: id }, { $set: { active } });
}
export async function setPartnerFee(id: string, fee: FeeRule) {
  await (await partnersCol()).updateOne({ _id: id }, { $set: { fee } });
}
export async function rotatePartnerKeys(id: string) {
  const apiKey = `wpk_${randomBytes(24).toString("hex")}`;
  const webhookSecret = `wsk_${randomBytes(32).toString("hex")}`;
  const r = await (await partnersCol()).updateOne({ _id: id }, { $set: { apiKeyHash: sha256(apiKey), webhookSecret } });
  if (r.matchedCount !== 1) throw new WalletError("partner_not_found", 404);
  return { apiKey, webhookSecret };
}

export async function authenticatePartner(authHeader: unknown): Promise<PartnerDoc | null> {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  if (!/^wpk_[0-9a-f]{48}$/.test(key)) return null;
  const p = await (await partnersCol()).findOne({ apiKeyHash: sha256(key) });
  return p && p.active ? p : null;
}

// ------------------------------------------------------------ outbound calls
export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const a = Buffer.from(signBody(secret, timestamp, body), "hex");
  const b = Buffer.from(String(signature), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;
let fetcher: Fetcher = (url, init) => fetch(url, init as any) as any;
/** Test hook. */
export function setPartnerFetcher(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init as any) as any);
}

async function callPartner(p: PartnerDoc, path: string, payload: Record<string, unknown>): Promise<{ http: number; body: any } | null> {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetcher(`${p.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Wallet-Timestamp": ts, "X-Wallet-Signature": signBody(p.webhookSecret, ts, body) },
      body,
      signal: ctl.signal,
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { http: res.status, body: json };
  } catch {
    return null; // network / timeout
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePartnerDest(partnerId: unknown, token: unknown): Promise<DestInfo> {
  if (typeof partnerId !== "string") throw new WalletError("partner_unavailable");
  const p = await getPartner(partnerId);
  if (!p || !p.active) throw new WalletError("partner_unavailable", 503);
  if (typeof token !== "string" || !token.trim() || token.length > 128) throw new WalletError("invalid_token");
  const r = await callPartner(p, "/resolve", { token: token.trim() });
  if (!r) throw new WalletError("partner_unavailable", 503);
  if (r.http === 404 || r.body?.code === "unknown_token") throw new WalletError("target_not_found", 404);
  if (r.http !== 200 || r.body?.ok !== true || typeof r.body.displayName !== "string") throw new WalletError("partner_unavailable", 503);
  const t = token.trim();
  return { kind: "partner", partnerId, displayName: r.body.displayName.slice(0, 40), tokenMasked: t.length > 6 ? `${t.slice(0, 3)}••••${t.slice(-3)}` : "••••" };
}

/**
 * Deliver (or re-deliver) a pending wallet->partner transfer. Idempotent: the partner
 * dedups on transferId. Returns the resulting ledger status.
 */
export async function deliverToPartner(ledgerId: string): Promise<"completed" | "pending" | "refunded" | "unknown"> {
  const led = await ledgerCol();
  const row = await led.findOne({ _id: ledgerId });
  if (!row || row.kind !== "to_partner") return "unknown";
  if (row.status !== "pending") return row.status === "completed" ? "completed" : row.status === "refunded" ? "refunded" : "unknown";
  const p = row.partnerId ? await getPartner(row.partnerId) : null;
  if (!p) return "pending";
  const token = (row as any).destToken as string | undefined;
  await led.updateOne({ _id: ledgerId, status: "pending" }, { $inc: { attempts: 1 } });
  const r = await callPartner(p, "/receive", {
    transferId: ledgerId,
    token,
    amount: row.amount,
    from: { name: row.fromName ?? null, walletUserId: row.fromUser },
    createdAt: row.createdAt.toISOString(),
  });
  if (!r) {
    await led.updateOne({ _id: ledgerId, status: "pending" }, { $set: { lastError: "network" } });
    return "pending";
  }
  if (r.http === 200 && r.body?.ok === true) {
    await led.updateOne({ _id: ledgerId, status: "pending" }, { $set: { status: "completed", completedAt: new Date(), logged: false }, $unset: { destToken: "" } });
    await notifyTx(ledgerId);
    return "completed";
  }
  const definitive = (r.http >= 400 && r.http < 500 && r.http !== 408 && r.http !== 429) || (r.http === 200 && r.body?.ok === false && r.body?.retryable !== true);
  if (definitive) return refundPartnerTransfer(ledgerId, String(r.body?.code ?? `http_${r.http}`));
  await led.updateOne({ _id: ledgerId, status: "pending" }, { $set: { lastError: `http_${r.http}` } });
  return "pending";
}

/** Atomic refund of a pending partner transfer (guarded: only once, only while pending). */
export async function refundPartnerTransfer(ledgerId: string, reason: string): Promise<"refunded" | "pending" | "completed" | "unknown"> {
  try {
    return await runTx(async (session) => {
      const led = await ledgerCol();
      const row = await led.findOneAndUpdate(
        { _id: ledgerId, kind: "to_partner", status: "pending" },
        { $set: { status: "refunded", completedAt: new Date(), lastError: reason.slice(0, 80), logged: false }, $unset: { destToken: "" } },
        { returnDocument: "after", session },
      );
      if (!row) throw new WalletError("noop");
      const back = row.amount + row.fee;
      // the fee was kept by the wallet only on success; on refund the sender gets everything back
      const pr = await (await partnersCol()).updateOne({ _id: row.partnerId!, balance: { $gte: row.amount } }, { $inc: { balance: -row.amount } }, { session });
      if (pr.matchedCount !== 1) throw new WalletError("partner_balance_inconsistent");
      await (await accounts()).updateOne({ _id: row.fromUser! }, { $inc: { balance: back } }, { session });
      if (row.fee > 0) await (await (await import("./walletCore.js")).supplyCol()).updateOne({ _id: "supply" }, { $inc: { feesCollected: -row.fee } }, { session });
      await insertLedger({ _id: `refund:${ledgerId}`, kind: "refund", amount: back, fromUser: null, toUser: row.fromUser, from: row.to, to: row.from, toName: row.fromName, refundOf: ledgerId, note: reason.slice(0, 80) }, session);
      return "refunded" as const;
    }).then(async (r) => { await notifyTx(ledgerId); return r; });
  } catch (err) {
    if (err instanceof WalletError && err.code === "noop") {
      const row = await (await ledgerCol()).findOne({ _id: ledgerId });
      return row?.status === "completed" ? "completed" : row?.status === "refunded" ? "refunded" : row ? "pending" : "unknown";
    }
    throw err;
  }
}

/** Retry every pending partner delivery (cron + opportunistic). Returns counts. */
export async function retryPendingDeliveries(limit = 25, onlyUser?: number): Promise<{ tried: number; completed: number; refunded: number }> {
  const filter: any = { kind: "to_partner", status: "pending" };
  if (onlyUser !== undefined) filter.fromUser = onlyUser;
  const rows = await (await ledgerCol()).find(filter).sort({ createdAt: 1 }).limit(limit).toArray();
  let completed = 0, refunded = 0;
  for (const r of rows) {
    const s = await deliverToPartner(r._id);
    if (s === "completed") completed++;
    if (s === "refunded") refunded++;
  }
  return { tried: rows.length, completed, refunded };
}

// ------------------------------------------------------------ inbound (partner -> wallet)
export interface PartnerApiResult { status: number; body: Record<string, unknown> }

export async function handlePartnerRequest(p: PartnerDoc, bodyIn: any): Promise<PartnerApiResult> {
  const action = typeof bodyIn?.action === "string" ? bodyIn.action : "";
  const db = await getDb();

  const lookupWallet = async (rawToken: unknown) => {
    if (rawToken === undefined && Number.isInteger(bodyIn?.userId)) {
      const acct = await (await accounts()).findOne({ _id: bodyIn.userId });
      if (!acct) throw new WalletError("target_not_found", 404);
      const u = await db.collection<UserDoc>("users").findOne({ _id: acct._id });
      if (!u || u.banned) throw new WalletError("target_not_found", 404);
      return { acct, u };
    }
    const token = normalizeWalletToken(rawToken);
    if (!token) throw new WalletError("invalid_token");
    const acct = await getAccountByToken(token);
    if (!acct) throw new WalletError("target_not_found", 404);
    const u = await db.collection<UserDoc>("users").findOne({ _id: acct._id });
    if (!u || u.banned) throw new WalletError("target_not_found", 404);
    return { acct, u };
  };
  const externalId = () => {
    const v = typeof bodyIn?.externalId === "string" ? bodyIn.externalId.trim() : "";
    if (!/^[A-Za-z0-9:_\-.]{1,80}$/.test(v)) throw new WalletError("invalid_external_id");
    return v;
  };
  const amountOf = async () => {
    // A purchase-button id (set by the owner in the admin panel) can replace `amount`: the Relic amount then comes from the owner's config.
    if (action === "credit" && typeof bodyIn?.packageId === "string") {
      const pk = ((await getSettings()).packages ?? []).find((x) => x.id === bodyIn.packageId);
      if (!pk) throw new WalletError("package_not_found", 404);
      return pk.relic;
    }
    const a = bodyIn?.amount;
    if (!Number.isInteger(a) || a <= 0 || a > 100_000_000) throw new WalletError("invalid_amount");
    return a as number;
  };

  try {
    if (action === "resolve") {
      const { u, acct } = await lookupWallet(bodyIn?.token);
      return { status: 200, body: { ok: true, displayName: displayNameOf(u), walletUserId: acct._id } };
    }

    if (action === "deposit" || action === "credit") {
      const { acct, u } = await lookupWallet(bodyIn?.token);
      const amount = await amountOf();
      const ext = externalId();
      if (action === "credit" && !p.canIssue) throw new WalletError("not_allowed", 403);
      const ledgerId = `${action === "credit" ? "pcredit" : "pdeposit"}:${p._id}:${ext}`;
      const existing = await (await ledgerCol()).findOne({ _id: ledgerId });
      if (existing) return { status: 200, body: { ok: true, duplicate: true, txId: ledgerId, status: existing.status } };
      try {
        await runTx(async (session) => {
          if (action === "deposit") {
            const r = await (await partnersCol()).updateOne({ _id: p._id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { session });
            if (r.matchedCount !== 1) throw new WalletError("insufficient_partner_balance");
          } else {
            await issueFromSupply(amount, session);
          }
          await (await accounts()).updateOne({ _id: acct._id }, { $inc: { balance: amount } }, { session });
          await insertLedger({
            _id: ledgerId, kind: action === "credit" ? "purchase_credit" : "from_partner", amount, fromUser: null, toUser: acct._id,
            from: action === "credit" ? "supply" : `partner:${p._id}`, to: `wallet:${acct._id}`, fromName: p.name, toName: displayNameOf(u),
            partnerId: p._id, note: typeof bodyIn?.reason === "string" ? bodyIn.reason.slice(0, 80) : undefined,
          }, session);
        });
      } catch (err: any) {
        if (err?.code === 11000) return { status: 200, body: { ok: true, duplicate: true, txId: ledgerId } };
        throw err;
      }
      const fresh = await (await accounts()).findOne({ _id: acct._id });
      const rowC = await (await ledgerCol()).findOne({ _id: ledgerId });
      if (action === "credit") await notifyTx(ledgerId);
      return { status: 200, body: { ok: true, duplicate: false, txId: ledgerId, code: rowC?.code ?? null, status: "completed", walletBalance: fresh?.balance ?? null } };
    }

    if (action === "status") {
      const id = typeof bodyIn?.transferId === "string" ? bodyIn.transferId : "";
      const row = await (await ledgerCol()).findOne({ _id: id });
      if (!row || row.partnerId !== p._id) throw new WalletError("not_found", 404);
      return { status: 200, body: { ok: true, transferId: id, state: row.status, amount: row.amount } };
    }

    if (action === "balance") {
      const fresh = await getPartner(p._id);
      return { status: 200, body: { ok: true, balance: fresh?.balance ?? 0 } };
    }

    throw new WalletError("bad_action");
  } catch (err) {
    if (err instanceof WalletError) return { status: err.status, body: { ok: false, error: err.code } };
    throw err;
  }
}
export type { WalletLedgerDoc };
