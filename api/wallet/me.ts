import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePreflight, authenticateWalletRequest, sendWalletError } from "./_shared.js";
import { getUser } from "../../src/db/models/user.js";
import { TAPS_PER_RELIC, WalletError, effectiveBalance, displayNameOf, getOrCreateAccount, getSettings, getSupply } from "../../src/db/models/walletCore.js";
import { claimTask, gateFor, listTasksForUser } from "../../src/db/models/walletTasks.js";
import { listHistory } from "../../src/db/models/walletTransfers.js";
import { getMiningCarry } from "../../src/db/models/walletMining.js";
import { listPartners, retryPendingDeliveries } from "../../src/db/models/walletPartners.js";
import { flushTxLog } from "../../src/services/walletTxLog.js";

/**
 * GET  /api/wallet/me?initData=...          legacy: Nava balance (unchanged fields) + wallet basics
 * POST /api/wallet/me { initData, action }  action: state | tasks | task_claim | history
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handlePreflight(req, res)) return;

  const tgUser = authenticateWalletRequest(req);
  if (!tgUser) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const user = await getUser(tgUser.id);
    if (!user) {
      res.status(404).json({ error: "not_found", message: "Open the bot with /start first." });
      return;
    }
    if (user.banned) throw new WalletError("banned", 403);

    if (req.method === "GET") {
      const acct = await getOrCreateAccount(user._id);
      res.status(200).json({
        telegramId: user._id, anonId: user.anonId, nickname: user.nickname ?? null,
        relicBalance: user.relicBalance ?? 0, // Nava balance (legacy field name kept)
        walletBalance: await effectiveBalance(user._id, acct.balance), walletToken: acct.token,
      });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    const action = typeof req.body?.action === "string" ? req.body.action : "";

    if (action === "state") {
      const [acct, settings, supply, carry, partners] = await Promise.all([
        getOrCreateAccount(user._id), getSettings(), getSupply(), getMiningCarry(user._id), listPartners(true),
      ]);
      const gate = await gateFor(user._id, acct.tapsTotal);
      res.status(200).json({
        telegramId: user._id,
        name: displayNameOf(user),
        navaBalance: user.relicBalance ?? 0,
        wallet: {
          balance: await effectiveBalance(user._id, acct.balance), token: acct.token, carryTaps: carry, tapsPerRelic: TAPS_PER_RELIC, tapsTotal: acct.tapsTotal,
          tomanRate: settings.tomanRate, supply: { cap: supply.cap, remaining: supply.remaining },
        },
        gate: { blocked: gate.blocked, task: gate.task },
        settings: {
          transferMin: settings.transferMin, transferMax: settings.transferMax,
          fees: { wallet: settings.feeWallet, nava: settings.feeNava },
          partners: partners.map((p) => ({ id: p._id, name: p.name, fee: p.fee })),
        },
      });
      return;
    }

    if (action === "tasks") {
      res.status(200).json({ tasks: await listTasksForUser(user._id) });
      return;
    }

    if (action === "task_claim") {
      res.status(200).json(await claimTask(user._id, req.body?.taskId));
      return;
    }

    if (action === "history") {
      // opportunistically settle this user's pending partner deliveries so nothing hangs
      await retryPendingDeliveries(5, user._id).catch(() => undefined);
      await flushTxLog(10);
      res.status(200).json(await listHistory(user._id, req.body?.cursor));
      return;
    }

    res.status(400).json({ error: "bad_action" });
  } catch (err) {
    sendWalletError(res, err);
  }
}
