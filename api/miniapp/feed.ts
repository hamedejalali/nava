import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePost, readBody } from "./_shared.js";
import { authenticateViewer, ensureMiniappIndexesOnce, pickCandidate, sanitizeExclude, viewerHasJoinedChannels } from "../../src/services/miniapp.js";

/** POST /api/miniapp/feed  { initData, exclude?: string[] }
 *  -> { candidate: { id } | null }   (id = public Nava ID, never a Telegram id) */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requirePost(req, res)) return;
  try {
    ensureMiniappIndexesOnce();
    const body = readBody(req);
    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) return void res.status(viewer.status).json({ error: viewer.error });
    if (!(await viewerHasJoinedChannels(viewer.user))) return void res.status(403).json({ error: "join_required" });

    const candidate = await pickCandidate(viewer.user._id, sanitizeExclude(body.exclude));
    res.status(200).json({ candidate: candidate ? { id: candidate.anonId } : null });
  } catch (err) {
    console.error("[miniapp:feed] failed:", err);
    res.status(500).json({ error: "server_error" });
  }
}
