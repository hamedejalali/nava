import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleWalletRequest } from "../src/services/wallet/walletApi.js";
import { botApi } from "../src/services/miniapp.js";
import { env } from "../src/config/env.js";

/**
 * Wallet -> Nava XP API (thin shell). Public routes are rewritten in vercel.json:
 *   /api/wallet/v1/:op  ->  /api/wallet?op=:op        (op = resolve | credit | status)
 * The body must reach the signature check UNTOUCHED, so Vercel's body parser is switched off and the raw
 * bytes are read here. Contract + signing recipe: docs/WALLET_API.md
 */
export const config = { api: { bodyParser: false } };

async function readRaw(req: VercelRequest, limit = 8192): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer | string>) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const opRaw = req.query?.op;
  const op = Array.isArray(opRaw) ? String(opRaw[0] ?? "") : String(opRaw ?? "");
  const raw = await readRaw(req);
  if (raw === null) return void res.status(413).json({ ok: false, error: { code: "payload_too_large", message: "Body too large." } });
  const fwd = req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"];
  const ip = String(Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0]!.trim();

  const out = await handleWalletRequest(
    { method: req.method ?? "GET", op, rawBody: raw, headers: req.headers as Record<string, string | string[] | undefined>, ip },
    {
      notifyUser: async (userId, text) => void (await botApi().sendMessage(userId, text)),
      notifyOwner: async (text) => {
        if (env.OWNER_ID !== undefined) await botApi().sendMessage(env.OWNER_ID, text);
      },
    }
  );
  res.status(out.status).json(out.body);
}
