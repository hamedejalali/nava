import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateViewer,
  botApi,
  downloadTelegramFile,
  ensureMiniappIndexesOnce,
  findEligibleTarget,
  pickCandidate,
  sanitizeExclude,
  viewerHasJoinedChannels,
} from "../src/services/miniapp.js";
import { authenticateStaff } from "../src/services/monitor.js";
import { SocialError, checkUsername, ensureSocialIndexesOnce, setBio, setLike, setMiniUsername, uploadProfilePhoto } from "../src/services/miniappSocial.js";
import { createChatRequest } from "../src/db/models/chatRequest.js";
import { sendChatRequestToTarget } from "../src/features/matching/chatRequest.js";
import { getDb } from "../src/db/connect.js";
import { getSupportLink } from "../src/features/support/index.js";
import { checkRateLimit } from "../src/utils/rateLimit.js";
import { env } from "../src/config/env.js";
import { parsePid } from "../src/services/nava/common.js";
import { loadMedia, verifyMediaSig } from "../src/services/nava/media.js";
import { present } from "../src/services/nava/present.js";
import { addComment, createPost, deleteComment, deletePost, editPost, getPostItem, listComments, listFeed, listUserPosts, setPostLike } from "../src/services/nava/posts.js";
import { activeStoriesOf, createHighlight, createStory, deleteHighlight, deleteStory, editHighlight, getHighlight, markStoryViewed, storiesTray, storyArchive, storyViewers } from "../src/services/nava/stories.js";
import { listFollows, setFollow } from "../src/services/nava/follow.js";
import { giftCatalog, listReceivedGifts, regiftGift, sendGift } from "../src/services/nava/gifts.js";
import { logAdminAction } from "../src/db/models/adminLog.js";
import { reportPost } from "../src/services/nava/postReports.js";
import { giftAnimUrl, loadGiftSticker, verifyGiftAnimSig } from "../src/services/nava/giftSticker.js";
import { getProfile, findRequestTarget, requestProfileChange } from "../src/services/nava/profile.js";
import { explore, recentAdd, recentClear, recentList, recentRemove, searchPeople } from "../src/services/nava/search.js";
import { prepareShare } from "../src/services/nava/share.js";

/**
 * Navagram (نوا گرام) Mini App backend — ONE serverless function with an `action`
 * (Vercel's Hobby plan caps a deployment at 12 functions, so related endpoints are grouped).
 *
 *   POST /api/miniapp  { action, initData, ...args }  -> JSON
 *   GET  /api/miniapp?m=<mediaId>&s=<sig>             -> a post / story / cover image (signed, cacheable)
 *   GET  /api/miniapp?u=<anonId>&v=<ver>&s=<sig>      -> a profile photo (signed, cacheable)
 *
 * Identity comes ONLY from the HMAC-signed initData; the page is served from the same origin so no
 * CORS is needed. Telegram ids never leave the server (people are addressed by their public Nava ID).
 */

/** Short-lived memo of the force-join check so paging/searching does not hit Telegram's getChatMember
 *  on every call. Only POSITIVE results are cached. */
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

const ACTIONS = new Set([
  // identity / profile
  "whoami", "me", "profile", "check_username", "set_username", "set_bio", "upload_photo", "request_change",
  // feed / explore / search
  "home", "explore", "search", "recent_add", "recent_remove", "recent_clear",
  // posts
  "posts", "post", "post_create", "post_edit", "post_delete", "post_report", "like", "comments", "comment_add", "comment_delete",
  // follow
  "follow", "follows",
  // stories + highlights
  "stories", "story_create", "story_view", "story_viewers", "story_delete", "story_archive",
  "highlight", "highlight_create", "highlight_edit", "highlight_delete",
  // gifts / share / chat request
  "gift_catalog", "gift_send", "gift_regift", "gifts", "share", "request",
  // legacy (v1.14/v1.15 clients)
  "feed", "photo",
]);

/** Per-person API budget per minute (see the rate-limit block in the handler). */
export const MINIAPP_CALLS_PER_MINUTE = 300;

const SOCIAL_ERRORS: Record<string, number> = {
  taken: 409, too_short: 400, too_long: 400, bad_chars: 400, bad_dots: 400, reserved: 400,
  bad_bio: 400, bio_too_long: 400, bad_image: 400, bad_text: 400, text_too_long: 400, bad_input: 400, bad_gift: 400,
  bad_name: 400, bad_age: 400, same_value: 400, pending_request: 409, self: 400,
  too_fast: 429, too_many: 429, insufficient: 402, forbidden: 403, comments_off: 403, not_found: 404,
  unavailable: 503, share_unavailable: 503, sold_out: 409,
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

function q1(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
}

/** GET: signed images. No login (an <img> cannot send initData) — the signature proves the URL came from us. */
async function serveImage(req: VercelRequest, res: VercelResponse): Promise<void> {
  const m = q1(req.query?.m);
  const u = q1(req.query?.u);
  const s = q1(req.query?.s);
  if (m) {
    if (m.length > 24 || !verifyMediaSig(m, s)) return void res.status(403).end();
    const media = await loadMedia(m);
    if (!media) return void res.status(404).end();
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return void res.status(200).send(media.buffer);
  }
  if (u) {
    if (u.length > 32 || !verifyMediaSig(`u:${u}`, s)) return void res.status(403).end();
    const db = await getDb();
    const user = await db.collection<any>("users").findOne({ anonId: u, banned: { $ne: true } }, { projection: { profilePhotoFileId: 1 } });
    if (!user?.profilePhotoFileId) return void res.status(404).end();
    const file = await downloadTelegramFile(user.profilePhotoFileId);
    if (!file) return void res.status(404).end();
    res.setHeader("Content-Type", file.contentType);
    // the URL carries the photo version (&v=), so it can be cached "forever": a new photo = a new URL
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return void res.status(200).send(file.buffer);
  }
  const g = q1(req.query?.g);
  if (g) {
    const v = q1(req.query?.v);
    if (g.length > 12 || v.length > 64 || !verifyGiftAnimSig(g, v, s)) return void res.status(403).end();
    const anim = await loadGiftSticker(g, v);
    if (!anim) return void res.status(404).end();
    res.setHeader("Content-Type", anim.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return void res.status(200).send(anim.buffer);
  }
  res.status(400).end();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      return await serveImage(req, res);
    } catch (err) {
      console.error("[miniapp] image failed:", err instanceof Error ? err.message : "unknown error");
      return void res.status(500).end();
    }
  }
  if (req.method !== "POST") return void res.status(405).json({ error: "method_not_allowed" });

  try {
    ensureMiniappIndexesOnce();
    ensureSocialIndexesOnce();
    const body = readBody(req);
    const action = typeof body.action === "string" ? body.action : "";
    if (!ACTIONS.has(action)) return void res.status(400).json({ error: "bad_action" });

    // Owner / admins get the monitoring panel instead of the social app (unless they ask for user mode).
    const staff = action === "whoami" || action === "check_username" || action === "set_username" || action === "post_delete" || action === "comment_delete" || action === "story_delete" ? await authenticateStaff(body.initData) : null;
    if (action === "whoami" && staff?.ok && body.asUser !== true) return void res.status(200).json({ role: "staff" });

    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) {
      // A banned person is told how to reach support (a link, never the support id as text) — same ban as in the bot.
      if (viewer.error === "banned") return void res.status(viewer.status).json({ error: "banned", support: await getSupportLink().catch(() => null) });
      return void res.status(viewer.status).json({ error: viewer.error });
    }
    const me = viewer.user;
    // Abuse protection (v1.16.3): per-person budget, counted in MongoDB so it holds across serverless instances.
    // Generous (a person scrolling the app makes a few calls per second at most); fails OPEN if the limiter
    // itself is unavailable so a limiter outage never locks everybody out.
    try {
      const rl = await checkRateLimit(me._id, "miniapp", MINIAPP_CALLS_PER_MINUTE, 60_000);
      if (!rl.allowed) return void res.status(429).json({ error: "too_fast" });
    } catch (err) {
      console.error("[miniapp] rate limiter unavailable:", err instanceof Error ? err.name : "unknown");
    }
    const send = (data: unknown) => void res.status(200).json(present(data));

    if (action === "whoami") {
      if (!(await joinedOk(me))) return void res.status(403).json({ error: "join_required" });
      return send({ role: "user", me: await getProfile(me, me.anonId), bot: env.BOT_USERNAME?.replace(/^@/, "") ?? null, staff: !!staff?.ok });
    }

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
        /* ------------------------------------------------------ profile */
        case "me":
          return send({ me: await getProfile(me, me.anonId) });
        case "profile": {
          const p = await getProfile(me, body.id);
          return p ? send({ profile: p }) : void res.status(404).json({ error: "not_found" });
        }
        case "check_username":
          return void res.status(200).json(await checkUsername(me, body.username, !!staff?.ok));
        case "set_username":
          return void res.status(200).json({ username: await setMiniUsername(me, body.username, !!staff?.ok) });
        case "set_bio":
          return void res.status(200).json({ bio: await setBio(me, body.bio) });
        case "upload_photo":
          return void res.status(200).json({ status: await uploadProfilePhoto(me, body.image) });
        case "request_change": {
          if (body.field !== "nickname" && body.field !== "age") throw new SocialError("bad_input");
          return void res.status(200).json(await requestProfileChange(me, body.field, body.value));
        }

        /* ------------------------------------------- feed / explore / search */
        case "home": {
          const before = typeof body.before === "number" ? body.before : undefined;
          const feed = await listFeed(me._id, before);
          return send({ ...feed, tray: before ? undefined : await storiesTray(me._id) });
        }
        case "explore":
          return send(await explore(me._id, body.offset));
        case "search": {
          const q = typeof body.q === "string" ? body.q : "";
          return send(q.trim() ? { items: await searchPeople(me._id, q), recent: false } : { items: await recentList(me._id), recent: true });
        }
        case "recent_add":
          await recentAdd(me, body.id);
          return void res.status(200).json({ ok: true });
        case "recent_remove":
          await recentRemove(me, body.id);
          return void res.status(200).json({ ok: true });
        case "recent_clear":
          await recentClear(me);
          return void res.status(200).json({ ok: true });

        /* ---------------------------------------------------------- posts */
        case "posts": {
          const r = await listUserPosts(me._id, body.id, typeof body.before === "number" ? body.before : undefined);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }
        case "post": {
          const it = await getPostItem(me._id, body.pid);
          return it ? send({ item: it }) : void res.status(404).json({ error: "not_found" });
        }
        case "post_create":
          return send({ item: await createPost(me, body.image, body.caption, {}, { ratio: body.ratio, noComments: body.noComments, hideLikes: body.hideLikes }) });
        case "post_edit":
          return void res.status(200).json(await editPost(me, body.pid, { caption: body.caption, noComments: body.noComments, hideLikes: body.hideLikes }));
        case "post_delete": {
          const gone = await deletePost(me, body.pid, { asStaff: !!staff?.ok });
          if (gone && gone.ownerId !== me._id) {
            await logAdminAction(me._id, "miniapp_post_delete", `${body.pid}:${gone.ownerId}`).catch(() => {});
            await botApi().sendMessage(gone.ownerId, "⚠️ یکی از پست‌هات به‌خاطر نقض قوانین توسط مدیریت حذف شد.").catch(() => {});
          }
          return void res.status(200).json({ ok: true });
        }
        case "post_report":
          return send(await reportPost(me, body.pid, body.reason));
        case "like": {
          const pid = parsePid(body.pid);
          if (!pid) return void res.status(404).json({ error: "not_found" });
          const r = pid.kind === "profile" ? await setLike(me, pid.anonId, body.like !== false) : await setPostLike(me, body.pid, body.like !== false);
          return r ? void res.status(200).json(r) : void res.status(404).json({ error: "not_found" });
        }
        case "comments": {
          const r = await listComments(me._id, body.pid, typeof body.before === "number" ? body.before : undefined);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }
        case "comment_add":
          return send(await addComment(me, body.pid, body.text));
        case "comment_delete":
          return void res.status(200).json(await deleteComment(me, body.commentId, { asStaff: !!staff?.ok }));

        /* --------------------------------------------------------- follow */
        case "follow": {
          const r = await setFollow(me, body.id, body.follow !== false);
          return r ? void res.status(200).json(r) : void res.status(404).json({ error: "not_found" });
        }
        case "follows": {
          const r = await listFollows(me._id, body.id, body.type, typeof body.before === "number" ? body.before : undefined);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }

        /* ------------------------------------------- stories + highlights */
        case "stories": {
          const r = await activeStoriesOf(me._id, body.id);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }
        case "story_create":
          return send({ story: await createStory(me, body.image, body.caption) });
        case "story_view":
          return void res.status(200).json({ ok: await markStoryViewed(me, body.storyId) });
        case "story_viewers":
          return send(await storyViewers(me, body.storyId));
        case "story_delete":
        {
          const gone = await deleteStory(me, body.storyId, { asStaff: !!staff?.ok });
          if (gone && gone.ownerId !== me._id) await logAdminAction(me._id, "miniapp_story_delete", `${body.storyId}:${gone.ownerId}`).catch(() => {});
          return void res.status(200).json({ ok: true });
        }
        case "story_archive":
          return send({ items: await storyArchive(me) });
        case "highlight": {
          const r = await getHighlight(me._id, body.hid);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }
        case "highlight_create":
          return send({ highlight: await createHighlight(me, { title: body.title, storyIds: body.storyIds, coverStoryId: body.coverStoryId, coverImage: body.coverImage }) });
        case "highlight_edit":
          return send({ highlight: await editHighlight(me, body.hid, { title: body.title, storyIds: body.storyIds, coverStoryId: body.coverStoryId, coverImage: body.coverImage }) });
        case "highlight_delete":
          await deleteHighlight(me, body.hid);
          return void res.status(200).json({ ok: true });

        /* ----------------------------------------------------------- gifts */
        case "gift_catalog": {
          const bal = (await (await getDb()).collection<any>("users").findOne({ _id: me._id }, { projection: { relicBalance: 1 } }))?.relicBalance ?? 0;
          // `items` = what can be sent now; `all` also contains switched-off gifts so old gifts still render
          const withAnim = (cards: Awaited<ReturnType<typeof giftCatalog>>) => cards.map((c) => ({ ...c, anim: c.anim ? { format: c.anim.format, url: giftAnimUrl(c.id, c.anim.v) } : null }));
          return void res.status(200).json({ items: withAnim(await giftCatalog()), all: withAnim(await giftCatalog(true)), balance: bal as number });
        }
        case "gift_send":
          return send(await sendGift(me, body.id, body.giftId, body.message, body.clientId, {}, body.anonymous));
        case "gift_regift":
          return send(await regiftGift(me, body.gift, body.id, body.message, body.anonymous));
        case "gifts": {
          const r = await listReceivedGifts(me._id, body.id, typeof body.before === "number" ? body.before : undefined);
          return r ? send(r) : void res.status(404).json({ error: "not_found" });
        }

        /* ----------------------------------------------------------- share */
        case "share":
          return void res.status(200).json(await prepareShare(me, { pid: body.pid, uid: body.uid }));

        /* ---------------------------------------------------- chat request */
        case "request": {
          if (me.activeChatSessionId) return void res.status(200).json({ status: "in_chat" });
          if ((me.relicBalance ?? 0) < 1) return void res.status(200).json({ status: "no_balance" });
          const target = await findRequestTarget(me._id, body.id);
          if (!target) return void res.status(200).json({ status: "unavailable" });
          const created = await createChatRequest(me._id, target._id);
          if (created.status !== "created") return void res.status(200).json({ status: created.status });
          const delivered = await sendChatRequestToTarget(created.request, me, target);
          return void res.status(200).json({ status: delivered ? "sent" : "unavailable" });
        }

        /* ---------------------------------------------------------- legacy */
        case "feed": {
          const candidate = await pickCandidate(me._id, sanitizeExclude(body.exclude));
          return void res.status(200).json({ candidate: candidate ? { id: candidate.anonId } : null });
        }
      }
    } catch (err) {
      if (err instanceof SocialError) return void res.status(SOCIAL_ERRORS[err.code] ?? 400).json({ error: err.code });
      throw err;
    }
    return void res.status(400).json({ error: "bad_action" });
  } catch (err) {
    console.error("[miniapp] failed:", err instanceof Error ? err.message : "unknown error");
    res.status(500).json({ error: "server_error" });
  }
}
