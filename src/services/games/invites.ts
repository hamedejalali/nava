import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { getDb } from "../../db/connect.js";

/**
 * v1.30.0 — inline game invites.
 * A person types «@bot » in any chat and picks a game; the message that lands in the chat carries ONE button
 * t.me/<bot>?start=ig_<token>. The token is opaque: HMAC(host, game, day) cut to 16 URL-safe characters, so the host's Telegram id is never
 * exposed and the same host + game + day always gives the same token (a repeated inline query is an idempotent upsert, no feedback
 * from Telegram is needed). The invite doc lives 24 h. The TABLE is created later, when the host himself enters from that button.
 */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;
export const INVITE_TTL_MS = 24 * 3_600_000;

export interface InviteDoc {
  _id: string;
  hostId: number;
  gameKey: string;
  gid?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export function inviteToken(hostId: number, gameKey: string, now = Date.now()): string {
  const day = Math.floor(now / INVITE_TTL_MS);
  return createHmac("sha256", env.WEBHOOK_SECRET).update(`ig:${hostId}:${gameKey}:${day}`).digest("base64url").slice(0, 16);
}

let indexed = false;
async function invites() {
  const c = (await getDb()).collection<InviteDoc>("game_invites");
  if (!indexed) {
    await c.createIndex({ expiresAt: 1 }, { name: "ttl_expires", expireAfterSeconds: 0 }).catch(() => {});
    indexed = true;
  }
  return c;
}

/** Makes (or re-finds) the invite of this host for this game; returns its token. */
export async function ensureInvite(hostId: number, gameKey: string): Promise<string> {
  const token = inviteToken(hostId, gameKey);
  const now = new Date();
  await (await invites()).updateOne(
    { _id: token },
    { $setOnInsert: { hostId, gameKey, gid: null, createdAt: now, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) } },
    { upsert: true },
  );
  return token;
}

/** The live invite, or null (bad shape / unknown / expired). */
export async function getInvite(token: unknown): Promise<InviteDoc | null> {
  if (typeof token !== "string" || !INVITE_TOKEN_RE.test(token)) return null;
  const inv = await (await invites()).findOne({ _id: token });
  if (!inv || inv.expiresAt.getTime() <= Date.now()) return null;
  return inv;
}

export async function setInviteGid(token: string, gid: string): Promise<void> {
  await (await invites()).updateOne({ _id: token }, { $set: { gid } });
}
