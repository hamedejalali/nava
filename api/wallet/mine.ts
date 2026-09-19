import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePreflight, authenticateWalletRequest } from "./_shared.js";
import { creditMiningTaps } from "../../src/db/models/walletMining.js";
import { getUser } from "../../src/db/models/user.js";

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

  const user = await getUser(tgUser.id);
  if (!user) {
    res.status(404).json({ error: "not_found", message: "Open the bot with /start first." });
    return;
  }

  const rawTaps = Number(req.body?.taps);
  if (!Number.isFinite(rawTaps) || rawTaps < 0 || rawTaps > 10000) {
    res.status(400).json({ error: "invalid_taps" });
    return;
  }

  const result = await creditMiningTaps(tgUser.id, Math.floor(rawTaps));
  res.status(200).json(result);
}
