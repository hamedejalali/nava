import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api } from "grammy";
import { env } from "../../src/config/env.js";
import { safeEqual } from "../../src/utils/secureCompare.js";
import { syncWalletDeposits } from "../../src/services/wallet/walletDeposits.js";
import { processAllPendingOneBatchEach } from "../../src/services/broadcastProcessor.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || !safeEqual(provided, `Bearer ${env.CRON_SECRET}`)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const api = new Api(env.BOT_TOKEN);
  await processAllPendingOneBatchEach(api);
  // Wallet deposits (Flow A): daily safety net — the webhook sync (≈ every minute) and the open deposit screen do the normal work
  const wallet = await syncWalletDeposits(api, { force: true }).catch(() => null);
  res.status(200).json({ ok: true, wallet });
}
