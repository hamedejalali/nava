import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateViewer,
  downloadTelegramFile,
  ensureMiniappIndexesOnce,
  findEligibleTarget,
  pickCandidate,
  sanitizeExclude,
  viewerHasJoinedChannels,
} from "../src/services/miniapp.js";
import { createChatRequest } from "../src/db/models/chatRequest.js";
import { sendChatRequestToTarget } from "../src/features/matching/chatRequest.js";

/**
 * Nava user Mini App backend — ONE serverless function with an `action`
 * (Vercel's Hobby plan caps a deployment at 12 functions, so related
 * endpoints are grouped instead of one file each).
 *
 *   POST /api/miniapp  { action: "feed",    initData, exclude?: string[] } -> { candidate: { id } | null }
 *   POST /api/miniapp  { action: "photo",   initData, id }                 -> image bytes
 *   POST /api/miniapp  { action: "request", initData, id }                 -> { status }
 *
 * Identity comes ONLY from the HMAC-signed initData; the page is served from
 * the same origin so no CORS is needed. Telegram ids never leave the server
 * (candidates are addressed by their public Nava ID).
 */
function readBody(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === "object") return b as Record<string, unknown>;
  if (typeof b === "string") {
    try {
      const parsed = JSON.parse(b);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

  try {
    ensureMiniappIndexesOnce();
    const body = readBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    if (!["feed", "photo", "request"].includes(action)) return void res.status(400).json({ error: "bad_action" });

    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) return void res.status(viewer.status).json({ error: viewer.error });
    const me = viewer.user;

    if (action === "photo") {
      const target = await findEligibleTarget(me._id, body.id);
      if (!target?.profilePhotoFileId) return void res.status(404).json({ error: "not_found" });
      const file = await downloadTelegramFile(target.profilePhotoFileId);
      if (!file) return void res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return void res.status(200).send(file.buffer);
    }

    if (!(await viewerHasJoinedChannels(me))) return void res.status(403).json({ error: "join_required" });

    if (action === "feed") {
      const candidate = await pickCandidate(me._id, sanitizeExclude(body.exclude));
      return void res.status(200).json({ candidate: candidate ? { id: candidate.anonId } : null });
    }

    // action === "request"
    if (me.activeChatSessionId) return void res.status(200).json({ status: "in_chat" });
    if ((me.relicBalance ?? 0) < 1) return void res.status(200).json({ status: "no_balance" });
    const target = await findEligibleTarget(me._id, body.id);
    if (!target) return void res.status(200).json({ status: "unavailable" });

    const created = await createChatRequest(me._id, target._id);
    if (created.status !== "created") return void res.status(200).json({ status: created.status });
    const delivered = await sendChatRequestToTarget(created.request, me, target);
    return void res.status(200).json({ status: delivered ? "sent" : "unavailable" });
  } catch (err) {
    console.error("[miniapp] failed:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ error: "server_error" });
  }
}
