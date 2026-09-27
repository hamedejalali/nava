import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Api } from "grammy";
import { env } from "../../src/config/env.js";
import { processAllPendingOneBatchEach } from "../../src/services/broadcastProcessor.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || provided !== `Bearer ${env.CRON_SECRET}`) {
    res.status(401).send("Unauthorized");
    return;
  }

  const api = new Api(env.BOT_TOKEN);
  await processAllPendingOneBatchEach(api);
  res.status(200).json({ ok: true });
}
