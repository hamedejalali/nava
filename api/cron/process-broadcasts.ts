import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TELEGRAM_API_TIMEOUT_S } from "../../src/utils/fetchTimeout.js";
import { Api } from "grammy";
import { env } from "../../src/config/env.js";
import { recordCronRun } from "../../src/services/monitorOps.js";
import { safeEqual } from "../../src/utils/secureCompare.js";
import { syncWalletDeposits } from "../../src/services/wallet/walletDeposits.js";
import { processAllPendingOneBatchEach } from "../../src/services/broadcastProcessor.js";
import { getPendingJetonJobs } from "../../src/db/models/jetonJobs.js";
import { processJetonJob, sendJetonSummaryOnce } from "../../src/services/jetonMass.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || !safeEqual(provided, `Bearer ${env.CRON_SECRET}`)) {
    res.status(401).send("Unauthorized");
    return;
  }
  // v1.29.6: heartbeat — proves the schedule fires AND the secret matches (never throws; read by the monitoring panel)
  await recordCronRun("process-broadcasts");

  const api = new Api(env.BOT_TOKEN, { timeoutSeconds: TELEGRAM_API_TIMEOUT_S.cron });
  await processAllPendingOneBatchEach(api);
  for (const job of await getPendingJetonJobs()) {
    await processJetonJob(api, job, { budgetMs: 20_000 });
  }
  // Wallet deposits (Flow A): daily safety net — the webhook sync (≈ every minute) and the open deposit screen do the normal work
  const wallet = await syncWalletDeposits(api, { force: true }).catch(() => null);
  res.status(200).json({ ok: true, wallet });
}
