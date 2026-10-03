import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePost, readBody } from "./_shared.js";
import { authenticateViewer, ensureMiniappIndexesOnce, findEligibleTarget, viewerHasJoinedChannels } from "../../src/services/miniapp.js";
import { createChatRequest } from "../../src/db/models/chatRequest.js";
import { sendChatRequestToTarget } from "../../src/features/matching/chatRequest.js";

/** POST /api/miniapp/request { initData, id }
 *  -> { status: "sent" | "already_pending" | "rate_limited" | "no_balance" | "in_chat" | "unavailable" } */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requirePost(req, res)) return;
  try {
    ensureMiniappIndexesOnce();
    const body = readBody(req);
    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) return void res.status(viewer.status).json({ error: viewer.error });
    const me = viewer.user;

    if (!(await viewerHasJoinedChannels(me))) return void res.status(403).json({ error: "join_required" });
    if (me.activeChatSessionId) return void res.status(200).json({ status: "in_chat" });
    if ((me.relicBalance ?? 0) < 1) return void res.status(200).json({ status: "no_balance" });

    const target = await findEligibleTarget(me._id, body.id);
    if (!target) return void res.status(200).json({ status: "unavailable" });

    const created = await createChatRequest(me._id, target._id);
    if (created.status !== "created") return void res.status(200).json({ status: created.status });

    const delivered = await sendChatRequestToTarget(created.request, me, target);
    if (!delivered) return void res.status(200).json({ status: "unavailable" });
    res.status(200).json({ status: "sent" });
  } catch (err) {
    console.error("[miniapp:request] failed:", err);
    res.status(500).json({ error: "server_error" });
  }
}
