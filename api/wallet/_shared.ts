import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyTelegramWebAppInitData, type TelegramWebAppUser } from "../../src/utils/telegramWebApp.js";
import { env } from "../../src/config/env.js";
import { ensureWalletMiningIndexes } from "../../src/db/models/walletMining.js";
import { ensureRelicLedgerIndexes } from "../../src/db/models/relic.js";
import { ensureWalletRecoveryIndexes } from "../../src/db/models/walletRecovery.js";
import { ensureWalletCoreIndexes } from "../../src/db/models/walletCore.js";
import { ensureWalletTaskIndexes } from "../../src/db/models/walletTasks.js";
import { WalletError } from "../../src/db/models/walletCore.js";
import type { VercelResponse as Res } from "@vercel/node";

// Fire-and-forget index setup for the wallet API's own collections — the
// Nava bot's cold-start index setup (src/bot.ts) never runs for these
// serverless functions (mine.ts/transfer.ts/me.ts are a separate Vercel
// function bundle that never imports src/bot.ts), so without this,
// nothing ever created these indexes. Guarded so it only fires once per
// warm container; createIndexes itself is idempotent, so even a rare
// double-fire across concurrent cold starts is harmless.
let walletIndexesEnsured = false;
function ensureWalletIndexesOnce(): void {
  if (walletIndexesEnsured) return;
  walletIndexesEnsured = true;
  Promise.all([ensureWalletMiningIndexes(), ensureRelicLedgerIndexes(), ensureWalletRecoveryIndexes(), ensureWalletCoreIndexes(), ensureWalletTaskIndexes()]).catch((err) => {
    walletIndexesEnsured = false; // let the next request retry
    // eslint-disable-next-line no-console
    console.error("[wallet] index setup failed (will retry on next request):", err);
  });
}

/** Mini Apps are loaded inside Telegram's own webview, which calls this
 *  API from whatever origin the frontend is hosted on — so a fixed
 *  wildcard CORS is required here (there's no cookie/session to protect;
 *  the ONLY real security boundary is the initData signature check). */
export function setCors(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

/** Extracts and verifies the calling user from `initData` — sent either
 *  as a query string param (GET) or in the JSON body (POST). Returns null
 *  (caller should respond 401) if missing/invalid. */
export function authenticateWalletRequest(req: VercelRequest): TelegramWebAppUser | null {
  ensureWalletIndexesOnce();

  const token = env.WALLET_BOT_TOKEN;
  if (!token) return null;

  const initData = (req.method === "GET" ? req.query.initData : req.body?.initData) as string | undefined;
  if (!initData || typeof initData !== "string") return null;

  return verifyTelegramWebAppInitData(initData, token);
}

/** Maps a thrown error to the JSON error contract. Unknown errors become a generic 500 and
 *  log ONLY the error name (messages can embed document values). */
export function sendWalletError(res: Res, err: unknown): void {
  if (err instanceof WalletError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  console.error("[wallet] request failed:", err instanceof Error ? err.name : "unknown");
  res.status(500).json({ error: "server_error" });
}
