import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api } from "grammy";
import { env } from "../../src/config/env.js";
import { safeEqual } from "../../src/utils/secureCompare.js";
import { sweepPendingDeposits } from "../../src/services/wallet/walletDeposits.js";
import { processAllPendingOneBatchEach } from "../../src/services/broadcastProcessor.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || !safeEqual(provided, `Bearer ${env.CRON_SECRET}`)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const api = new Api(env.BOT_TOKEN);
  await processAllPendingOneBatchEach(api);
  // finish Wallet deposits the user approved but never came back to check (daily safety net; the button / inline poll do the normal work)
  const wallet = await sweepPendingDeposits(api).catch(() => null);
  res.status(200).json({ ok: true, wallet });
}
