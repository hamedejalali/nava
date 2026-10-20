import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateStaff, collectSnapshot, defaultSend, maybeRunAlertCheck } from "../src/services/monitor.js";
import { getDb } from "../src/db/connect.js";
import { allSeeds } from "../src/db/models/seeds.js";
import { photoVer } from "../src/services/nava/common.js";
import { present } from "../src/services/nava/present.js";

/** POST /api/monitor { initData, action: "snapshot" } — owner/admin only. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });
  try {
    const staff = await authenticateStaff(req.body?.initData);
    if (!staff.ok) return void res.status(staff.status).json({ error: staff.error });
    if (req.body?.action === "accounts") {
      // Instagram-style switcher: the real account (Nava / the owner) FIRST, then the default members
      const me: any = await (await getDb()).collection<any>("users").findOne({ _id: staff.id });
      const row = (u: any, main: boolean) => ({ id: u.anonId, name: u.nickname ?? "-", verified: !!u.verified, main, pv: photoVer(u.profilePhotoFileId) });
      const seeds = await allSeeds();
      return void res.status(200).json(present({ items: [...(me?.anonId ? [row(me, true)] : []), ...seeds.map((u: any) => row(u, false))] }));
    }
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
