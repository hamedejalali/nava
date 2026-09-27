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

  // FIXED (v1.4.0) — REQUIRED, not optional with a timing-based fallback.
  // A key derived from `Date.now()` (the original bug) or even a short
  // time bucket (an earlier, still-unsafe fix) can make two DIFFERENT,
  // legitimate transfers of the same amount to the same person within the
  // same short window collide and get silently deduped as "one transfer" —
  // exactly the failure mode a real idempotency key must avoid. The Mini
  // App must mint ONE id per transfer attempt (e.g. crypto.randomUUID())
  // when the user confirms, and resend the SAME id only if it has to retry
  // that exact attempt. Nothing in the current frontend calls this
  // endpoint yet (no transfer UI is wired up — see PREMIUM_WALLET/script.js
  // and the changelog), so requiring this now is not a breaking change for
  // any existing caller; it just makes the endpoint safe before a transfer
  // UI is ever built on top of it.
  const clientRequestId = typeof req.body?.clientRequestId === "string" ? req.body.clientRequestId.trim() : "";
  if (!clientRequestId || clientRequestId.length > 100) {
    res.status(400).json({ error: "missing_client_request_id" });
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

  const idempotencyKey = `wallet:${sender._id}:${clientRequestId}`;
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
  res.status(200).json({
    status: "ok",
    newSenderBalance: updatedSender?.relicBalance ?? 0,
    // Lets a future frontend tell "this just happened" apart from "this
    // was already applied by an earlier attempt with the same id" — the
    // balance is correct either way, this is purely informational.
    duplicate: result.status === "already_processed",
  });
}
