import type { ClientSession, Collection } from "mongodb";
import { randomBytes, randomUUID } from "node:crypto";
import { getClient, getDb } from "../connect.js";
import type { UserDoc } from "./user.js";
import { env } from "../../config/env.js";

/**
 * Premium Wallet core (v1.11.0). The wallet is its OWN ledger, separate from
 * the Nava bot's `users.relicBalance`:
 *
 *   wallet_accounts   one per Telegram user: integer `balance` + wallet token
 *   wallet_supply     singleton: total supply `cap`, `remaining` (not yet issued),
 *                     `issued`, `feesCollected`
 *   wallet_ledger     immutable, deterministic-id rows for EVERY movement
 *   wallet_intents    server-side "quotes": the ONLY way to move money out
 *   wallet_settings   singleton owner settings (never env)
 *   wallet_rate       fixed-window rate-limit counters (DB-backed)
 *
 * Conservation invariant (checked by tests):
 *   remaining + feesCollected + Σ wallet balances + Σ partner balances
 *     + Σ Nava credits that originated from the wallet  ==  cap
 *
 * Every money movement is ONE MongoDB transaction (ledger row + balance
 * changes together). Ledger ids are deterministic so replays are no-ops.
 */

export const DEFAULT_SUPPLY_CAP = 21_000_000;
export const TAPS_PER_RELIC = 475;
export const INTENT_TTL_MS = 2 * 60_000;

export interface WalletAccountDoc {
  _id: number;
  token: string;
  balance: number;
  tapsTotal: number;
  signupGranted?: boolean;
  createdAt: Date;
}
export interface WalletSupplyDoc {
  _id: "supply";
  cap: number;
  remaining: number;
  issued: number;
  feesCollected: number;
}
export interface FeeRule { pct: number; fixed: number }
export interface WalletTexts { welcome?: string; receive?: string; sendIntro?: string; balance?: string; buy?: string }
/** A purchase button shown in the wallet bot: label + payment link (placeholders {uid} {token}) + Relic credited when the payment API confirms. */
export interface BuyPackage { id: string; title: string; url: string; relic: number }
export interface WalletSettingsDoc {
  _id: "settings";
  txLogChatId?: number;
  txLogSince?: Date;
  taskReviewChatId?: number;
  /** owner-defined purchase packages (wallet bot «🛒 خرید رلیک») */
  packages?: BuyPackage[];
  signupBonus: number;
  tomanRate: number;
  transferMin: number;
  transferMax: number;
  feeWallet: FeeRule;
  feeNava: FeeRule;
  texts: WalletTexts;
}
export const DEFAULT_SETTINGS: Omit<WalletSettingsDoc, "_id"> = {
  signupBonus: 0,
  tomanRate: 350,
  transferMin: 1,
  transferMax: 1_000_000,
  feeWallet: { pct: 0, fixed: 0 },
  feeNava: { pct: 0, fixed: 0 },
  texts: {},
};

export type LedgerKind =
  | "mining" | "signup_bonus" | "task_reward" | "purchase_credit" | "admin_topup"
  | "transfer" | "to_nava" | "to_partner" | "from_partner" | "recovery" | "refund";
export type LedgerStatus = "completed" | "pending" | "failed" | "refunded";

export interface WalletLedgerDoc {
  _id: string;
  kind: LedgerKind;
  amount: number;
  fee: number;
  /** numeric Telegram ids when the party is a wallet / Nava user (for history queries) */
  fromUser: number | null;
  toUser: number | null;
  /** human-readable party refs: "wallet:123" "nava:123" "partner:id" "supply" */
  from: string;
  to: string;
  fromName?: string;
  toName?: string;
  status: LedgerStatus;
  note?: string;
  partnerId?: string;
  attempts?: number;
  lastError?: string;
  refundOf?: string;
  logged: boolean;
  /** tracking code shown to both parties and searchable in the admin panel */
  code?: string;
  /** last status for which the parties were notified */
  notified?: string;
  createdAt: Date;
  completedAt?: Date;
}

export class WalletError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

// ---------------------------------------------------------------- collections
export async function accounts(): Promise<Collection<WalletAccountDoc>> {
  return (await getDb()).collection<WalletAccountDoc>("wallet_accounts");
}
export async function supplyCol(): Promise<Collection<WalletSupplyDoc>> {
  return (await getDb()).collection<WalletSupplyDoc>("wallet_supply");
}
export async function ledgerCol(): Promise<Collection<WalletLedgerDoc>> {
  return (await getDb()).collection<WalletLedgerDoc>("wallet_ledger");
}
export async function settingsCol(): Promise<Collection<WalletSettingsDoc>> {
  return (await getDb()).collection<WalletSettingsDoc>("wallet_settings");
}

export async function ensureWalletCoreIndexes(): Promise<void> {
  const db = await getDb();
  await (await accounts()).createIndexes([{ key: { token: 1 }, name: "token_unique", unique: true }]);
  await (await ledgerCol()).createIndexes([
    { key: { fromUser: 1, createdAt: -1 }, name: "fromUser_createdAt" },
    { key: { toUser: 1, createdAt: -1 }, name: "toUser_createdAt" },
    { key: { status: 1, kind: 1 }, name: "status_kind" },
    { key: { logged: 1, createdAt: 1 }, name: "logged_createdAt" },
    { key: { code: 1 }, name: "code_unique", unique: true, partialFilterExpression: { code: { $type: "string" } } },
  ]);
  await db.collection("wallet_intents").createIndexes([{ key: { expiresAt: 1 }, name: "expires_ttl", expireAfterSeconds: 3600 }]);
  await db.collection("wallet_rate").createIndexes([{ key: { expiresAt: 1 }, name: "expires_ttl", expireAfterSeconds: 0 }]);
}

// ---------------------------------------------------------------- settings / supply
export async function getSettings(): Promise<WalletSettingsDoc> {
  const doc = await (await settingsCol()).findOne({ _id: "settings" });
  return {
    _id: "settings",
    ...DEFAULT_SETTINGS,
    ...(doc ?? {}),
    feeWallet: { ...DEFAULT_SETTINGS.feeWallet, ...(doc?.feeWallet ?? {}) },
    feeNava: { ...DEFAULT_SETTINGS.feeNava, ...(doc?.feeNava ?? {}) },
    texts: { ...(doc?.texts ?? {}) },
  };
}
export async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  await (await settingsCol()).updateOne({ _id: "settings" }, { $set: patch as any }, { upsert: true });
}

export async function getSupply(): Promise<WalletSupplyDoc> {
  const c = await supplyCol();
  const found = await c.findOne({ _id: "supply" });
  if (found) return found;
  try {
    await c.insertOne({ _id: "supply", cap: DEFAULT_SUPPLY_CAP, remaining: DEFAULT_SUPPLY_CAP, issued: 0, feesCollected: 0 });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }
  return (await c.findOne({ _id: "supply" }))!;
}

/** Owner: add `delta` (>0) to the total supply. */
export async function addSupply(delta: number): Promise<WalletSupplyDoc> {
  if (!Number.isInteger(delta) || delta <= 0) throw new WalletError("invalid_amount");
  await getSupply();
  await (await supplyCol()).updateOne({ _id: "supply" }, { $inc: { cap: delta, remaining: delta } });
  return getSupply();
}
/** Owner: set the total cap. Must not drop below what is already in circulation. */
export async function setSupplyCap(newCap: number): Promise<WalletSupplyDoc> {
  if (!Number.isInteger(newCap) || newCap <= 0) throw new WalletError("invalid_amount");
  const s = await getSupply();
  const delta = newCap - s.cap;
  if (delta === 0) return s;
  const c = await supplyCol();
  const r = await c.updateOne(delta > 0 ? { _id: "supply" } : { _id: "supply", remaining: { $gte: -delta } }, { $inc: { cap: delta, remaining: delta } });
  if (r.matchedCount !== 1) throw new WalletError("below_circulation");
  return getSupply();
}

/** The owner (OWNER_ID) holds the whole not-yet-distributed supply in their wallet: their visible balance is
 *  their own account balance + `supply.remaining`; anything they send is drawn from there. Everyone else: just `balance`. */
export const isWalletOwner = (userId: number) => env.OWNER_ID !== undefined && env.OWNER_ID === userId;
export async function effectiveBalance(userId: number, ownBalance: number): Promise<number> {
  if (!isWalletOwner(userId)) return ownBalance;
  return ownBalance + (await getSupply()).remaining;
}

/** Non-throwing variant for Nava-side rewards: returns false (and changes nothing) when the supply is short. */
export async function tryIssueFromSupply(amount: number, session: ClientSession): Promise<boolean> {
  await getSupply();
  const r = await (await supplyCol()).updateOne({ _id: "supply", remaining: { $gte: amount } }, { $inc: { remaining: -amount, issued: amount } }, { session });
  return r.matchedCount === 1;
}

/** Atomically take `amount` out of the not-yet-issued supply (inside a txn). Throws supply_exhausted. */
export async function issueFromSupply(amount: number, session: ClientSession): Promise<void> {
  await getSupply(); // make sure the singleton exists (first use after deploy)
  const c = await supplyCol();
  const r = await c.updateOne({ _id: "supply", remaining: { $gte: amount } }, { $inc: { remaining: -amount, issued: amount } }, { session });
  if (r.matchedCount !== 1) throw new WalletError("supply_exhausted");
}

// ---------------------------------------------------------------- tokens / accounts
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
export function generateWalletToken(): string {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i]! & 31];
  return `RLC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}
/** Canonical form of user input, or null if it can't be a wallet token. */
export function normalizeWalletToken(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const raw = input.toUpperCase().replace(/[\s\-_]/g, "");
  if (!/^RLC[A-Z2-9]{16}$/.test(raw)) return null;
  const b = raw.slice(3);
  if ([...b].some((ch) => !ALPHABET.includes(ch))) return null;
  return `RLC-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}`;
}
export function maskToken(token: string): string {
  return token.length > 9 ? `${token.slice(0, 8)}-••••-••••-${token.slice(-4)}` : "••••";
}

export async function getAccount(userId: number): Promise<WalletAccountDoc | null> {
  return (await accounts()).findOne({ _id: userId });
}
export async function getAccountByToken(token: string): Promise<WalletAccountDoc | null> {
  return (await accounts()).findOne({ token });
}

/** Creates the account on first use (and the one-time signup bonus). Safe to call concurrently. */
export async function getOrCreateAccount(userId: number): Promise<WalletAccountDoc> {
  const col = await accounts();
  let acct = await col.findOne({ _id: userId });
  if (!acct) {
    for (let i = 0; i < 5 && !acct; i++) {
      try {
        await col.insertOne({ _id: userId, token: generateWalletToken(), balance: 0, tapsTotal: 0, createdAt: new Date() });
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
      acct = await col.findOne({ _id: userId });
    }
    if (!acct) throw new WalletError("server_error", 500);
  }
  if (!acct.signupGranted) {
    const bonus = (await getSettings()).signupBonus;
    if (bonus > 0) await grantSignupBonus(userId, bonus).catch((e) => { if (!(e instanceof WalletError)) throw e; });
    else if (bonus === 0) { /* nothing to grant; flag stays unset so a later non-zero bonus still applies */ }
    acct = (await col.findOne({ _id: userId })) ?? acct;
  }
  return acct;
}

async function grantSignupBonus(userId: number, amount: number): Promise<void> {
  await runTx(async (session) => {
    const col = await accounts();
    const flipped = await col.updateOne({ _id: userId, signupGranted: { $ne: true } }, { $set: { signupGranted: true }, $inc: { balance: amount } }, { session });
    if (flipped.matchedCount !== 1) return;
    await issueFromSupply(amount, session);
    await insertLedger({ _id: `signup:${userId}`, kind: "signup_bonus", amount, fromUser: null, toUser: userId, from: "supply", to: `wallet:${userId}` }, session);
  });
}

// ---------------------------------------------------------------- tx helpers
export async function runTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getClient();
  const session = client.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

/** Tracking code, e.g. TX-7K3M9QX2 (alphabet without look-alike characters; unique index backs it up). */
export function generateTxCode(): string {
  const bytes = randomBytes(8);
  let c = "";
  for (let i = 0; i < 8; i++) c += ALPHABET[bytes[i]! & 31];
  return `TX-${c}`;
}
export function normalizeTxCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toUpperCase().replace(/[\s_-]/g, "").replace(/^TX/, "");
  if (t.length !== 8 || [...t].some((ch) => !ALPHABET.includes(ch))) return null;
  return `TX-${t}`;
}

export async function insertLedger(
  e: Partial<WalletLedgerDoc> & Pick<WalletLedgerDoc, "_id" | "kind" | "amount" | "from" | "to" | "fromUser" | "toUser">,
  session: ClientSession,
): Promise<WalletLedgerDoc> {
  const now = new Date();
  const doc: WalletLedgerDoc = { fee: 0, status: "completed", logged: false, code: generateTxCode(), createdAt: now, completedAt: now, ...e } as WalletLedgerDoc;
  if (doc.status === "pending") delete doc.completedAt;
  await (await ledgerCol()).insertOne(doc, { session });
  return doc;
}

// ---------------------------------------------------------------- rate limiting
/** Fixed-window counter in MongoDB (shared by all instances). Returns false once over `limit`. */
export async function takeRate(userId: number, key: string, limit: number, windowMs: number, now = new Date()): Promise<boolean> {
  const bucket = Math.floor(now.getTime() / windowMs);
  const col = (await getDb()).collection<any>("wallet_rate");
  const id = `${key}:${userId}:${bucket}`;
  await col.updateOne({ _id: id }, { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } }, { upsert: true });
  const doc = await col.findOne({ _id: id });
  return (doc?.n ?? 1) <= limit;
}

// ---------------------------------------------------------------- fees / destinations
export function computeFee(amount: number, rule: FeeRule): number {
  const pct = Number.isFinite(rule.pct) && rule.pct > 0 ? Math.ceil((amount * rule.pct) / 100) : 0;
  const fixed = Number.isInteger(rule.fixed) && rule.fixed > 0 ? rule.fixed : 0;
  return pct + fixed;
}

export interface DestInfo {
  kind: "wallet" | "nava" | "partner";
  partnerId?: string;
  displayName: string;
  tokenMasked: string;
  /** internal only (never sent to clients) */
  targetUserId?: number;
}

export function displayNameOf(u: Pick<UserDoc, "nickname" | "firstName"> | null | undefined): string {
  return (u?.nickname || u?.firstName || "کاربر").toString().slice(0, 40);
}

/** Resolves the destination token. Pure lookup; partner lookups live in walletPartners (injected). */
export async function resolveLocalDest(kind: "wallet" | "nava", rawToken: unknown, senderId: number): Promise<DestInfo> {
  const db = await getDb();
  if (kind === "wallet") {
    const token = normalizeWalletToken(rawToken);
    if (!token) throw new WalletError("invalid_token");
    const acct = await getAccountByToken(token);
    if (!acct) throw new WalletError("target_not_found", 404);
    if (acct._id === senderId) throw new WalletError("self_transfer");
    const u = await db.collection<UserDoc>("users").findOne({ _id: acct._id });
    if (!u || u.banned) throw new WalletError("target_not_found", 404);
    return { kind, displayName: displayNameOf(u), tokenMasked: maskToken(token), targetUserId: acct._id };
  }
  const anon = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!/^user_[A-Za-z0-9]{3,16}$/.test(anon)) throw new WalletError("invalid_token");
  const u = await db.collection<UserDoc>("users").findOne({ anonId: anon });
  if (!u || u.banned || u.onboardingStep !== "COMPLETED") throw new WalletError("target_not_found", 404);
  if (u._id === senderId) throw new WalletError("self_transfer");
  return { kind, displayName: displayNameOf(u), tokenMasked: anon.slice(0, 7) + "••••", targetUserId: u._id };
}

export function newIntentId(): string {
  return randomUUID();
}
