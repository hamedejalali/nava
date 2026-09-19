import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyTelegramWebAppInitData, type TelegramWebAppUser } from "../../src/utils/telegramWebApp.js";
import { env } from "../../src/config/env.js";

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
  const token = env.WALLET_BOT_TOKEN;
  if (!token) return null;

  const initData = (req.method === "GET" ? req.query.initData : req.body?.initData) as string | undefined;
  if (!initData || typeof initData !== "string") return null;

  return verifyTelegramWebAppInitData(initData, token);
}
