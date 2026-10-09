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
import { authenticateStaff } from "../src/services/monitor.js";
import {
  SocialError,
  checkUsername,
  ensureSocialIndexesOnce,
  getCard,
  listUsers,
  myProfile,
  searchUsers,
  setBio,
  setLike,
  setMiniUsername,
  uploadProfilePhoto,
} from "../src/services/miniappSocial.js";
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
 *   (v1.15) whoami | feed_page | explore | user | like | search |
 *           check_username | set_username | set_bio | upload_photo | me
 *
 * Identity comes ONLY from the HMAC-signed initData; the page is served from
 * the same origin so no CORS is needed. Telegram ids never leave the server
 * (candidates are addressed by their public Nava ID).
 */
/** Short-lived memo of the force-join check so paging/searching does not hit
 *  Telegram's getChatMember on every call. Only POSITIVE results are cached. */
const joinedCache = new Map<number, number>();
const JOIN_CACHE_MS = 60_000;
async function joinedOk(me: Parameters<typeof viewerHasJoinedChannels>[0]): Promise<boolean> {
  const hit = joinedCache.get(me._id);
  if (hit && hit > Date.now()) return true;
  const ok = await viewerHasJoinedChannels(me);
  if (ok) {
    if (joinedCache.size > 5000) joinedCache.clear();
    joinedCache.set(me._id, Date.now() + JOIN_CACHE_MS);
  }
  return ok;
}

const ACTIONS = [
  "whoami", "feed", "photo", "request",
  "feed_page", "explore", "user", "like", "search",
  "check_username", "set_username", "set_bio", "upload_photo", "me",
];
const SOCIAL_ERRORS: Record<string, number> = {
  taken: 409, too_short: 400, too_long: 400, bad_chars: 400, bad_dots: 400, reserved: 400,
  bad_bio: 400, bio_too_long: 400, bad_image: 400, too_fast: 429, unavailable: 503,
};

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
    ensureSocialIndexesOnce();
    const body = readBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    if (!ACTIONS.includes(action)) return void res.status(400).json({ error: "bad_action" });

    // Owner / admins get the monitoring panel instead of the social app.
    const staff = action === "whoami" || action === "check_username" || action === "set_username" ? await authenticateStaff(body.initData) : null;
    if (action === "whoami" && staff?.ok && body.asUser !== true) return void res.status(200).json({ role: "staff" });

    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) return void res.status(viewer.status).json({ error: viewer.error });
    const me = viewer.user;

    if (action === "whoami") {
      if (!(await joinedOk(me))) return void res.status(403).json({ error: "join_required" });
      return void res.status(200).json({ role: "user", me: await myProfile(me) });
    }
    if (action === "me") return void res.status(200).json({ me: await myProfile(me) });

    if (action === "photo") {
      const target = body.id === me.anonId && me.profilePhotoFileId ? me : await findEligibleTarget(me._id, body.id);
      if (!target?.profilePhotoFileId) return void res.status(404).json({ error: "not_found" });
      const file = await downloadTelegramFile(target.profilePhotoFileId);
      if (!file) return void res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      return void res.status(200).send(file.buffer);
    }

    if (!(await joinedOk(me))) return void res.status(403).json({ error: "join_required" });

    try {
      switch (action) {
        case "feed_page":
        case "explore": {
          const offset = typeof body.offset === "number" ? body.offset : 0;
          return void res.status(200).json(await listUsers(me._id, { order: action === "explore" ? "top" : "new", offset }));
        }
        case "user": {
          const card = await getCard(me._id, body.id);
          return card ? void res.status(200).json({ user: card }) : void res.status(404).json({ error: "not_found" });
        }
        case "like": {
          const r = await setLike(me, body.id, body.like !== false);
          return r ? void res.status(200).json(r) : void res.status(404).json({ error: "not_found" });
        }
        case "search":
          return void res.status(200).json({ items: await searchUsers(me._id, body.q) });
        case "check_username":
          return void res.status(200).json(await checkUsername(me, body.username, !!staff?.ok));
        case "set_username":
          return void res.status(200).json({ username: await setMiniUsername(me, body.username, !!staff?.ok) });
        case "set_bio":
          return void res.status(200).json({ bio: await setBio(me, body.bio) });
        case "upload_photo":
          return void res.status(200).json({ status: await uploadProfilePhoto(me, body.image) });
      }
    } catch (err) {
      if (err instanceof SocialError) return void res.status(SOCIAL_ERRORS[err.code] ?? 400).json({ error: err.code });
      throw err;
    }

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
