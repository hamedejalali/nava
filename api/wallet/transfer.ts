import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePreflight, authenticateWalletRequest } from "./_shared.js";
import { getUser, getUserByAnonId } from "../../src/db/models/user.js";
import { transferRelicOnce } from "../../src/db/models/relic.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const tgUser = authenticateWalletRequest(req);
  if (!tgUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const sender = await getUser(tgUser.id);
  if (!sender) {
    res.status(404).json({ error: "not_found", message: "Open the bot with /start first." });
    return;
  }

  const targetAnonId = String(req.body?.targetAnonId ?? "").trim();
  const amount = Number(req.body?.amount);
  if (!targetAnonId || !Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const target = await getUserByAnonId(targetAnonId);
  if (!target) {
    res.status(404).json({ error: "target_not_found" });
    return;
  }
  if (target._id === sender._id) {
    res.status(400).json({ error: "cannot_transfer_to_self" });
    return;
  }

  // A fresh idempotency key per HTTP call — a client-side retry of the
  // exact same tap would need to reuse this key to be deduped; since the
  // Mini App only calls this once per explicit user-confirmed transfer,
  // a random key here is correct (unlike the bot's confirm-dialog flow,
  // there's no multi-step callback replay risk to guard against).
  const idempotencyKey = `wallet:${sender._id}:${target._id}:${Date.now()}`;

  const result = await transferRelicOnce(idempotencyKey, sender._id, target._id, amount);
  if (result.status === "insufficient") {
    res.status(400).json({ error: "insufficient_balance" });
    return;
  }
  if (result.status === "invalid") {
    res.status(400).json({ error: "invalid_amount" });
    return;
  }

  const updatedSender = await getUser(sender._id);
  res.status(200).json({ status: "ok", newSenderBalance: updatedSender?.relicBalance ?? 0 });
}
