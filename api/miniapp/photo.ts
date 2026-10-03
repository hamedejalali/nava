import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePost, readBody } from "./_shared.js";
import { authenticateViewer, downloadTelegramFile, findEligibleTarget } from "../../src/services/miniapp.js";

/** POST /api/miniapp/photo { initData, id } -> image bytes.
 *  Only serves the approved profile photo of a currently eligible,
 *  registered user — never an arbitrary file_id. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requirePost(req, res)) return;
  try {
    const body = readBody(req);
    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) return void res.status(viewer.status).json({ error: viewer.error });

    const target = await findEligibleTarget(viewer.user._id, body.id);
    if (!target?.profilePhotoFileId) return void res.status(404).json({ error: "not_found" });

    const file = await downloadTelegramFile(target.profilePhotoFileId);
    if (!file) return void res.status(404).json({ error: "not_found" });

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).send(file.buffer);
  } catch (err) {
    console.error("[miniapp:photo] failed:", err);
    res.status(500).json({ error: "server_error" });
  }
}
