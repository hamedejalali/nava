import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Update } from "grammy/types";
import { createWalletBot } from "../src/walletBot.js";
import { env } from "../src/config/env.js";

const bot = createWalletBot();
let botInitPromise: Promise<void> | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(200).send("Nava Wallet Bot webhook is alive.");
    return;
  }

  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== env.WALLET_WEBHOOK_SECRET) {
    res.status(401).send("unauthorized");
    return;
  }

  try {
    if (!botInitPromise) botInitPromise = bot.init();
    await botInitPromise;
    await bot.handleUpdate(req.body as Update);
  } catch (err) {
    console.error("[wallet-webhook] Failed to process update:", err);
  }

  if (!res.headersSent) {
    res.status(200).send("ok");
  }
}
