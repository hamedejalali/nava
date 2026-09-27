import { randomBytes } from "node:crypto";
import { getClient, getDb } from "../connect.js";
import { chargeRelicInSession } from "./relic.js";

/**
 * "Who viewed my profile?" paid reveal.
 *
 * When user 1 (not in a chat) looks up user 2's Nava ID, user 2 gets an
 * anonymous notice with a "پرداخت" button. One row here = one such notice.
 * Paying is atomic: the status flip pending->paid and the Relic deduction
 * happen in ONE MongoDB transaction, so a double tap can never charge
 * twice, and a failed payment never marks the notice as paid.
 */
export interface ProfileRevealDoc {
  _id: string;
  viewerId: number; // the person who looked (revealed only after payment)
  targetId: number; // the profile owner — the only one who may pay
  status: "pending" | "paid";
  createdAt: Date;
  paidAt?: Date;
  expiresAt: Date;
}

const TTL_DAYS = 30;

async function col() {
  const db = await getDb();
  return db.collection<ProfileRevealDoc>("profile_view_reveals");
}

export async function ensureProfileRevealIndexes(): Promise<void> {
  const c = await col();
  await c.createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]);
}

export async function createReveal(viewerId: number, targetId: number): Promise<string> {
  const id = randomBytes(9).toString("base64url"); // 12 chars, fits callback_data
  await (await col()).insertOne({
    _id: id,
    viewerId,
    targetId,
    status: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
  });
  return id;
}

export async function getReveal(id: string): Promise<ProfileRevealDoc | null> {
  return (await col()).findOne({ _id: id });
}

export type PayRevealResult =
  | { status: "paid"; viewerId: number }
  | { status: "already_paid"; viewerId: number }
  | { status: "insufficient" }
  | { status: "not_found" };

export async function payReveal(revealId: string, payerId: number, cost: number): Promise<PayRevealResult> {
  const client = await getClient();
  const reveals = await col();
  const session = client.startSession();

  try {
    let result: PayRevealResult = { status: "not_found" };

    await session.withTransaction(async () => {
      const reveal = await reveals.findOne({ _id: revealId, targetId: payerId }, { session });
      if (!reveal) {
        result = { status: "not_found" };
        return;
      }
      if (reveal.status === "paid") {
        result = { status: "already_paid", viewerId: reveal.viewerId };
        return;
      }

      const charged = await chargeRelicInSession(payerId, cost, `reveal:${revealId}`, "PROFILE_VIEW_REVEAL", revealId, session);
      if (!charged) {
        result = { status: "insufficient" };
        return;
      }

      await reveals.updateOne({ _id: revealId }, { $set: { status: "paid", paidAt: new Date() } }, { session });
      result = { status: "paid", viewerId: reveal.viewerId };
    });

    return result;
  } finally {
    await session.endSession();
  }
}
