import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../../db/connect.js";
import { runInTransaction } from "../../db/tx.js";

/**
 * USER TRANSFER TOKEN — identifies ONE Nava account for Wallet -> Nava XP transfers.
 *
 * It is NOT an API credential: on its own it can do nothing. The Wallet integration must ALSO sign every
 * request with its own secret (see walletAuth.ts); the token only tells Nava WHO to credit. It can never read
 * data, spend XP, or call any other endpoint.
 *
 *  - 256 random bits from crypto.randomBytes (never derived from a Telegram id / username / time);
 *  - only its SHA-256 hash is stored (the token is shown to the user once, when it is created);
 *  - exactly one ACTIVE token per user (partial unique index); creating a new one revokes the old one in the
 *    same transaction, so a rotated / revoked token never authorises a new transfer again.
 */

export const TOKEN_PREFIX = "nxp_";
const TOKEN_RE = /^nxp_[A-Za-z0-9_-]{43}$/;
export const TOKENS = "xp_transfer_tokens";

export interface TransferTokenDoc {
  _id: string; // token id (public, random) — NOT the secret
  userId: number;
  hash: string; // sha256 hex of the full token
  hint: string; // last 4 characters, only to let the owner recognise "which one is active"
  status: "active" | "revoked";
  createdAt: Date;
  revokedAt?: Date;
  revokedReason?: "rotated" | "user" | "admin";
  lastUsedAt?: Date;
  uses: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap shape check done BEFORE touching the database (garbage never costs a query). */
export function isTokenShape(x: unknown): x is string {
  return typeof x === "string" && TOKEN_RE.test(x);
}

async function tokens() {
  return (await getDb()).collection<TransferTokenDoc>(TOKENS);
}

let indexed = false;
export async function ensureTransferTokenIndexes(): Promise<void> {
  if (indexed) return;
  const c = await tokens();
  await c.createIndexes([
    { key: { hash: 1 }, name: "token_hash_unique", unique: true },
    { key: { userId: 1 }, name: "one_active_token_per_user", unique: true, partialFilterExpression: { status: "active" } },
  ]);
  indexed = true;
}
/** test helper: forget the memo (the fake database is reset between tests) */
export function resetTransferTokenIndexMemo(): void {
  indexed = false;
}

/** Creates a NEW token for the user and revokes the previous active one (atomic). Returns the secret ONCE. */
export async function issueTransferToken(userId: number): Promise<{ token: string; hint: string; createdAt: Date }> {
  await ensureTransferTokenIndexes();
  const c = await tokens();
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const now = new Date();
    try {
      await runInTransaction(async (s) => {
        await c.updateMany({ userId, status: "active" }, { $set: { status: "revoked", revokedAt: now, revokedReason: "rotated" } }, { session: s });
        await c.insertOne({ _id: randomBytes(9).toString("base64url"), userId, hash: hashToken(token), hint: token.slice(-4), status: "active", createdAt: now, uses: 0 }, { session: s });
      });
      return { token, hint: token.slice(-4), createdAt: now };
    } catch (err: any) {
      if (err?.code === 11000 && attempt < 2) continue; // two taps at once: the loser retries and simply rotates again
      throw err;
    }
  }
  throw new Error("token issue failed");
}

export async function getActiveTokenInfo(userId: number): Promise<{ hint: string; createdAt: Date; lastUsedAt?: Date; uses: number } | null> {
  const doc = await (await tokens()).findOne({ userId, status: "active" });
  return doc ? { hint: doc.hint, createdAt: doc.createdAt, lastUsedAt: doc.lastUsedAt, uses: doc.uses } : null;
}

export async function revokeTransferToken(userId: number, reason: "user" | "admin" = "user"): Promise<boolean> {
  const r = await (await tokens()).updateMany({ userId, status: "active" }, { $set: { status: "revoked", revokedAt: new Date(), revokedReason: reason } });
  return r.modifiedCount > 0;
}

export type ResolveTokenResult =
  | { status: "ok"; userId: number; tokenId: string; tokenHash: string }
  | { status: "invalid" | "revoked" | "user_unavailable" };

/** Maps a token to its (eligible) user. Never reveals anything but the verdict. */
export async function resolveTransferToken(token: unknown): Promise<ResolveTokenResult> {
  if (!isTokenShape(token)) return { status: "invalid" };
  const hash = hashToken(token);
  const doc = await (await tokens()).findOne({ hash });
  if (!doc) return { status: "invalid" };
  if (doc.status !== "active") return { status: "revoked" };
  const user: any = await (await getDb()).collection<any>("users").findOne({ _id: doc.userId }, { projection: { banned: 1, isSeed: 1, onboardingStep: 1 } });
  if (!user || user.banned || user.isSeed || user.onboardingStep !== "COMPLETED") return { status: "user_unavailable" };
  return { status: "ok", userId: doc.userId, tokenId: doc._id, tokenHash: hash };
}

export async function markTokenUsed(tokenId: string): Promise<void> {
  await (await tokens()).updateOne({ _id: tokenId }, { $set: { lastUsedAt: new Date() }, $inc: { uses: 1 } }).catch(() => {});
}
