import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePreflight, authenticateWalletRequest } from "./_shared.js";
import { getUser } from "../../src/db/models/user.js";
import {
  claimRecoveryPhrase,
  confirmRecoveryPhrase,
  generateRecoveryPhrase,
  getRecoveryState,
  normalizePhrase,
  refundAttempt,
  takeAttempt,
} from "../../src/db/models/walletRecovery.js";

/**
 * POST /api/wallet/recovery   { initData, action, phrase? }
 *   action "status"   -> { state: "none" | "pending_backup" | "active" }
 *   action "generate" -> { words: string[12] }   (shown ONCE; only a hash is stored)
 *   action "confirm"  -> { status: "confirmed" }   user typed the phrase back
 *   action "claim"    -> { status: "claimed", movedAmount, newBalance }
 *
 * One function for the whole feature (Vercel Hobby allows 12 per project).
 * The identity is the HMAC-verified initData user — never a client field.
 * The phrase is never logged: no request body, no phrase and no error
 * object that could contain them is ever passed to console.*.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handlePreflight(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

  const tgUser = authenticateWalletRequest(req);
  if (!tgUser) return void res.status(401).json({ error: "unauthorized" });

  try {
    const me = await getUser(tgUser.id);
    if (!me) return void res.status(404).json({ error: "not_found", message: "Open the bot with /start first." });
    if (me.banned) return void res.status(403).json({ error: "blocked" });

    const action = typeof req.body?.action === "string" ? req.body.action : "";

    if (action === "status") {
      return void res.status(200).json({ state: await getRecoveryState(me._id) });
    }

    if (action === "generate") {
      const r = await generateRecoveryPhrase(me._id);
      if (r.status === "already_active") return void res.status(409).json({ error: "already_active" });
      return void res.status(200).json({ words: r.words });
    }

    if (action === "confirm" || action === "claim") {
      const attempt = await takeAttempt(me._id);
      if (!attempt.allowed) return void res.status(429).json({ error: "rate_limited" });

      const phrase = normalizePhrase(req.body?.phrase);
      if (!phrase) return void res.status(400).json({ error: "invalid_phrase" });

      if (action === "confirm") {
        const r = await confirmRecoveryPhrase(me._id, phrase);
        if (r.status === "mismatch") return void res.status(400).json({ error: "invalid_phrase" });
        await refundAttempt(me._id);
        return void res.status(200).json({ status: r.status });
      }

      const r = await claimRecoveryPhrase(me._id, phrase);
      if (r.status === "invalid") return void res.status(400).json({ error: "invalid_phrase" });
      if (r.status === "same_account") return void res.status(400).json({ error: "same_account" });
      if (r.status === "blocked") return void res.status(403).json({ error: "blocked" });
      if (r.status === "rate_limited") return void res.status(429).json({ error: "rate_limited" });
      await refundAttempt(me._id);
      return void res.status(200).json(r);
    }

    return void res.status(400).json({ error: "bad_action" });
  } catch (err) {
    console.error("[wallet:recovery] failed:", err instanceof Error ? err.name : "unknown error"); // name only: messages can embed document values
    res.status(500).json({ error: "server_error" });
  }
}
