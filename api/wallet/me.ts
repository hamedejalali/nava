import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePreflight, authenticateWalletRequest } from "./_shared.js";
import { getUser } from "../../src/db/models/user.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handlePreflight(req, res)) return;

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

  res.status(200).json({
    telegramId: user._id,
    anonId: user.anonId,
    nickname: user.nickname ?? null,
    relicBalance: user.relicBalance ?? 0,
  });
}
