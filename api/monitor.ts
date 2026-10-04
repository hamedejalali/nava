import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateStaff, collectSnapshot, defaultSend, maybeRunAlertCheck } from "../src/services/monitor.js";

/** POST /api/monitor { initData, action: "snapshot" } — owner/admin only. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });
  try {
    const staff = await authenticateStaff(req.body?.initData);
    if (!staff.ok) return void res.status(staff.status).json({ error: staff.error });
    if (req.body?.action !== "snapshot") return void res.status(400).json({ error: "bad_action" });
    const snapshot = await collectSnapshot();
    // Opening the dashboard doubles as an alert evaluation (deduped by the DB lease/cooldown).
    await maybeRunAlertCheck({ send: defaultSend });
    res.status(200).json(snapshot);
  } catch (err) {
    console.error("[monitor] failed:", err instanceof Error ? err.name : "unknown");
    res.status(500).json({ error: "server_error" });
  }
}
