import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasUnlimitedXp } from "../src/db/models/relic.js";
import {
  authenticateViewer,
  botApi,
  downloadTelegramFile,
  ensureMiniappIndexesOnce,
  findEligibleTarget,
  pickCandidate,
  sanitizeExclude,
  missingChannels,
  MINIAPP_INITDATA_MAX_AGE_SECONDS,
} from "../src/services/miniapp.js";
import { authenticateStaff } from "../src/services/monitor.js";
import { SocialError, checkUsername, ensureSocialIndexesOnce, setBio, setCoin, setLike, setLocation, setMiniUsername, setOfficialChatOpen, uploadProfilePhoto } from "../src/services/miniappSocial.js";
import { createChatRequest } from "../src/db/models/chatRequest.js";
import { sendChatRequestToTarget } from "../src/features/matching/chatRequest.js";
import { getDb } from "../src/db/connect.js";
import { getSupportLink } from "../src/features/support/index.js";
import { checkRateLimit } from "../src/utils/rateLimit.js";
import { env } from "../src/config/env.js";
import { onboardCities, onboardSave, onboardState } from "../src/services/miniOnboarding.js";
import { pickGuestCards, markMatchSeen, markMatchSeenById, pickMemberCards, sanitizeMatchExclude } from "../src/services/matchCards.js";
import { verifyTelegramWebAppInitData } from "../src/utils/telegramWebApp.js";
import { adminDeleteGift } from "../src/services/nava/giftAdmin.js";
import { findVisibleUser, isOfficial, parsePid } from "../src/services/nava/common.js";
import { loadMedia, verifyMediaSig } from "../src/services/nava/media.js";
import { present } from "../src/services/nava/present.js";
import { addComment, createPost, deleteComment, deletePost, editPost, getPostItem, listComments, listFeed, listUserPosts, setCommentLike, setPostLike } from "../src/services/nava/posts.js";
import { listNotifs, markNotifsSeen, unreadCounts } from "../src/services/nava/notifs.js";
import { activeStoriesOf, createHighlight, createStory, deleteHighlight, deleteStory, editHighlight, getHighlight, markStoryViewed, replyToStory, setStoryLike, storiesTray, storyArchive, storyViewers } from "../src/services/nava/stories.js";
import { ensureOfficialFollow, countFollowRequests, listFollowRequests, listFollows, respondFollowRequest, setFollow, setPrivate } from "../src/services/nava/follow.js";
import { allSeeds, getSeedByAnonId } from "../src/db/models/seeds.js";
import { getMaintenanceState, maintenanceAllows, maintenanceText } from "../src/services/maintenance.js";
import { photoVer } from "../src/services/nava/common.js";
import { giftCatalog, listReceivedGifts, regiftGift, sendGift } from "../src/services/nava/gifts.js";
import { logAdminAction } from "../src/db/models/adminLog.js";
import { reportPost } from "../src/services/nava/postReports.js";
import { giftAnimUrl, loadGiftSticker, verifyGiftAnimSig } from "../src/services/nava/giftSticker.js";
import { getProfile, findRequestTarget, requestProfileChange, setProfileVisibility, effectiveHide } from "../src/services/nava/profile.js";
import { hasPendingProfilePhoto } from "../src/db/models/imageModeration.js";
import { explore, recentAdd, recentClear, recentList, recentRemove, searchPeople } from "../src/services/nava/search.js";
import { prepareShare } from "../src/services/nava/share.js";
import { waitUntil } from "@vercel/functions";
import { GAME_ACTIONS, GAME_ACTING_NEVER, GAME_ERRORS, gamePulse, handleGameAction } from "../src/services/games/index.js";
import { deleteThreadForMe, cancelRequest, dmPulse, endThread, listRequests, openThread, overview as dmOverview, respondRequest, sendPhoto as dmSendPhoto, sendText as dmSendText } from "../src/services/nava/dm.js";
import { blockInApp, listBlocked, reportInApp, unblockInApp } from "../src/services/nava/safety.js";
import { sendOfficialMessage } from "../src/services/nava/dm.js";
import { staffModerate, type StaffOp } from "../src/services/nava/staffMod.js";

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
/** Channels the person still has to join ([] = fine). Positive answers are cached briefly so a busy moment
 *  (many people opening the app) does not hammer Telegram's getChatMember. */
async function joinMissing(me: Parameters<typeof missingChannels>[0]): Promise<Array<{ title: string; url: string }>> {
  const hit = joinedCache.get(me._id);
  if (hit && hit > Date.now()) return [];
  const miss = await missingChannels(me);
  if (miss.length === 0) {
    if (joinedCache.size > 5000) joinedCache.clear();
    joinedCache.set(me._id, Date.now() + JOIN_CACHE_MS);
  }
  return miss;
}

let cachedBotName: string | null = null;
async function botUsername(): Promise<string | null> {
  const fromEnv = env.BOT_USERNAME?.replace(/^@/, "");
  if (fromEnv) return fromEnv;
  if (cachedBotName) return cachedBotName;
  try { cachedBotName = (await botApi().getMe()).username ?? null; } catch { /* the app falls back to copying a link */ }
  return cachedBotName;
}
const ACTIONS = new Set([
  // identity / profile
  "whoami", "guest_cards", "onboard_state", "onboard_cities", "onboard_save", "match_cards", "match_seen", "me", "profile", "check_username", "set_username", "set_bio", "upload_photo", "request_change", "set_visibility", "set_location", "official_chat",
  // feed / explore / search
  "home", "explore", "search", "recent_add", "recent_remove", "recent_clear",
  // posts
  "posts", "post", "post_create", "post_edit", "post_delete", "post_report", "like", "comments", "comment_add", "comment_delete", "comment_like",
  // activity (heart) + live pulse
  "notifs", "notifs_seen", "pulse",
  // follow + private page
  "follow", "follows", "set_private", "follow_requests", "follow_respond",
  // owner / admins: work as a default member
  "accounts",
  // stories + highlights
  "stories", "story_create", "story_view", "story_viewers", "story_like", "story_reply", "story_delete", "story_archive",
  "highlight", "highlight_create", "highlight_edit", "highlight_delete",
  // gifts / share / chat request
  "gift_catalog", "gift_send", "gift_regift", "gifts", "share", "request",
  // direct messages (Navagram chat) + chat requests inbox
  "dm_overview", "dm_open", "dm_send", "dm_photo", "dm_end", "dm_delete", "official_send", "gift_remove", "set_coin", "dm_requests", "dm_respond", "dm_cancel",
  // safety: block / report (synced with the bot) and staff moderation from a profile's ⋮ menu
  "block", "unblock", "blocked_list", "report", "mod",
  // backgammon (experimental two-player game)
  ...GAME_ACTIONS,
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
  unavailable: 503, share_unavailable: 503, sold_out: 409, busy: 409, ...GAME_ERRORS, chat_ended: 409, contact_forbidden: 400, need_photo: 403, bad_input2: 400,
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
  // hardening: an image URL can never run script, leak a referrer, or be indexed
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
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
    const wantsActAs = typeof body.actAs === "string" && body.actAs.length > 0;
    const staff = action === "whoami" || action === "accounts" || wantsActAs || action === "check_username" || action === "set_username" || action === "post_delete" || action === "comment_delete" || action === "story_delete" || action === "mod" || action === "gift_remove" ? await authenticateStaff(body.initData) : null;
    if (action === "whoami" && staff?.ok && body.asUser !== true) return void res.status(200).json({ role: "staff" });

    // Guest preview: somebody who opened the mini-app WITHOUT finishing registration in the bot sees 5 fictional
    // member cards in the Matching tab. Signed initData is still required; nothing else is reachable.
    if (action === "guest_cards") {
      const tg = typeof body.initData === "string" && body.initData.length <= 4096 ? verifyTelegramWebAppInitData(body.initData, env.BOT_TOKEN, MINIAPP_INITDATA_MAX_AGE_SECONDS) : null;
      if (!tg) return void res.status(401).json({ error: "unauthorized" });
      try {
        const rl = await checkRateLimit(tg.id, "miniapp-guest", 20, 60_000);
        if (!rl.allowed) return void res.status(429).json({ error: "too_fast" });
      } catch {
        /* limiter down: fail open, like the rest of the app */
      }
      return void res.status(200).json(present({ cards: await pickGuestCards(), bot: env.BOT_USERNAME?.replace(/^@/, "") ?? null }));
    }

    // In-app registration (same fields/ending as the bot's questions) for people who have not finished them yet.
    if (action === "onboard_state" || action === "onboard_cities" || action === "onboard_save") {
      const tg = typeof body.initData === "string" && body.initData.length <= 4096 ? verifyTelegramWebAppInitData(body.initData, env.BOT_TOKEN, MINIAPP_INITDATA_MAX_AGE_SECONDS) : null;
      if (!tg) return void res.status(401).json({ error: "unauthorized" });
      try {
        const rl = await checkRateLimit(tg.id, "miniapp-onboard", 40, 60_000);
        if (!rl.allowed) return void res.status(429).json({ error: "too_fast" });
      } catch {
        /* limiter down: fail open */
      }
      if (action === "onboard_cities") {
        const cities = onboardCities(body.province);
        return cities ? void res.status(200).json({ cities }) : void res.status(400).json({ error: "bad_input" });
      }
      if (action === "onboard_state") {
        const st = await onboardState(tg);
        return "banned" in st ? void res.status(403).json({ error: "banned", support: await getSupportLink().catch(() => null) }) : void res.status(200).json(st);
      }
      const r = await onboardSave(tg, { gender: body.gender, age: body.age, province: body.province, city: body.city, nickname: body.nickname }, botApi());
      if (r.status === "invalid") return void res.status(400).json({ error: "invalid_" + r.field });
      if (r.status === "banned") return void res.status(403).json({ error: "banned" });
      return void res.status(200).json({ status: r.status });
    }

    const viewer = await authenticateViewer(body.initData);
    if (!viewer.ok) {
      // A banned person is told how to reach support (a link, never the support id as text) — same ban as in the bot.
      if (viewer.error === "banned") return void res.status(viewer.status).json({ error: "banned", support: await getSupportLink().catch(() => null) });
      return void res.status(viewer.status).json({ error: viewer.error });
    }
    // Bot switched OFF: only staff and the allow-list get through (same rule as the bot); everybody else sees the text.
    const maint = await getMaintenanceState();
    if (maint.on && !maintenanceAllows(maint, viewer.user._id, viewer.user)) {
      return void res.status(503).json({ error: "maintenance", text: await maintenanceText() });
    }
    let me = viewer.user;
    // "Switch account" (owner/admins only, verified from the signed initData — never trusted from the client):
    // every action below then runs AS that default member.
    let acting = false;
    if (wantsActAs && body.actAs !== me.anonId) {
      if (!staff?.ok) return void res.status(403).json({ error: "forbidden" });
      const seed = await getSeedByAnonId(String(body.actAs).slice(0, 32));
      if (!seed) return void res.status(404).json({ error: "not_found" });
      me = seed;
      acting = true;
    }
    // A default member has no Relic: nothing that spends, earns or goes through moderation / Telegram as a real person.
    // (v1.23: chats — requests, accepting, writing — now work while acting as a default member / legal account; the real person on the
    // other side pays, the default member never does.) Legal ("حقوقی") accounts may also change their own name / photo.
    const ACTING_NEVER = ["gift_send", "gift_regift", "block", "unblock", "report", "mod", ...GAME_ACTING_NEVER];
    const ACTING_PLAIN_SEED_NEVER = ["upload_photo", "request_change"];
    if (acting && (ACTING_NEVER.includes(action) || (!isOfficial(me) && ACTING_PLAIN_SEED_NEVER.includes(action)))) return void res.status(403).json({ error: "forbidden" });
    // Abuse protection (v1.16.3): per-person budget, counted in MongoDB so it holds across serverless instances.
    // Generous (a person scrolling the app makes a few calls per second at most); fails OPEN if the limiter
    // itself is unavailable so a limiter outage never locks everybody out.
    try {
      const rl = await checkRateLimit(viewer.user._id, "miniapp", MINIAPP_CALLS_PER_MINUTE, 60_000);
      if (!rl.allowed) return void res.status(429).json({ error: "too_fast" });
    } catch (err) {
      console.error("[miniapp] rate limiter unavailable:", err instanceof Error ? err.name : "unknown");
    }
    const send = (data: unknown) => void res.status(200).json(present(data));

    if (action === "whoami") {
      const miss = await joinMissing(me);
      if (miss.length) return void res.status(403).json({ error: "join_required", channels: miss });
      if (!acting) await ensureOfficialFollow(me).catch((err) => console.error("[miniapp] official follow failed:", err instanceof Error ? err.name : "unknown"));
      return send({ role: "user", me: await getProfile(me, me.anonId), bot: await botUsername(), staff: !!staff?.ok, staffOwner: !!staff?.ok && env.OWNER_ID !== undefined && staff.id === env.OWNER_ID, acting: acting ? me.anonId : null });
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

    const missNow = await joinMissing(me);
    if (missNow.length) return void res.status(403).json({ error: "join_required", channels: missNow });

    try {
      switch (action) {
        /* ------------------------------------------------------ profile */
        case "me":
          return send({ me: await getProfile(me, me.anonId) });
        case "profile": {
          const p = await getProfile(me, body.id);
          return p ? send({ profile: p }) : void res.status(404).json({ error: "not_found" });
        }
        case "match_cards": {
          const r = await pickMemberCards(me, sanitizeMatchExclude(body.exclude));
          if (r === "need_photo") throw new SocialError("need_photo");
          return send({ cards: r });
        }
        case "match_seen":
          return void res.status(200).json({ ok: await markMatchSeen(me, body.id) });
        case "check_username":
          return void res.status(200).json(await checkUsername(me, body.username, !!staff?.ok));
        case "set_username":
          return void res.status(200).json({ username: await setMiniUsername(me, body.username, !!staff?.ok) });
        case "set_bio":
          return void res.status(200).json({ bio: await setBio(me, body.bio) });
        case "upload_photo":
          return void res.status(200).json({ status: await uploadProfilePhoto(me, body.image) });
        case "set_location":
          return void res.status(200).json(await setLocation(me, body.province, body.city));
        case "set_coin":
          return void res.status(200).json({ coin: await setCoin(me, body.coin) });
        case "official_chat":
          return void res.status(200).json({ open: await setOfficialChatOpen(me, body.open === true) });
        case "set_visibility":
          return void res.status(200).json({ hide: await setProfileVisibility(me, body.hide) });
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
            const why = typeof body.reason === "string" && body.reason.trim() ? `\nدلیل: ${body.reason.trim().slice(0, 200)}` : "";
            const note = "⚠️ یکی از پست‌هات به‌خاطر نقض قوانین توسط مدیریت حذف شد." + why;
            if (env.OWNER_ID !== undefined) await sendOfficialMessage(botApi(), env.OWNER_ID, gone.ownerId, note).catch(() => botApi().sendMessage(gone.ownerId, note).catch(() => {}));
            else await botApi().sendMessage(gone.ownerId, note).catch(() => {});
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
          return send(await addComment(me, body.pid, body.text, body.replyTo));
        case "comment_like": {
          const r = await setCommentLike(me, body.commentId, body.like !== false);
          return r ? void res.status(200).json(r) : void res.status(404).json({ error: "not_found" });
        }
        case "notifs":
          return send(await listNotifs(me._id, typeof body.before === "number" ? body.before : undefined));
        case "notifs_seen":
          await markNotifsSeen(me._id);
          return void res.status(200).json({ ok: true });
        case "pulse": {
          const u = await (await getDb()).collection<any>("users").findOne({ _id: me._id }, { projection: { relicBalance: 1, isPrivate: 1, miniUsername: 1, nickname: 1, age: 1, bio: 1, profilePhotoAt: 1, profilePhotoFileId: 1, profileHide: 1 } });
          // a tiny fingerprint of everything shown on the profile: when it changes (username / name / bio / photo edited from
          // the bot, an admin, or another device) the app refreshes the page at once instead of waiting for a reopen
          const sig = [u?.miniUsername ?? "", u?.nickname ?? "", u?.age ?? "", u?.bio ?? "", u?.profilePhotoAt ? new Date(u.profilePhotoAt).getTime() : "", u?.profilePhotoFileId ? 1 : 0, JSON.stringify(u ? effectiveHide({ ...u, _id: me._id }) : {}), (await hasPendingProfilePhoto(me._id)) ? "P" : ""].join("|");
          return void res.status(200).json({
            sig,
            relic: u?.relicBalance ?? 0,
            isPrivate: !!u?.isPrivate,
            requests: u?.isPrivate ? await countFollowRequests(me._id) : 0,
            unread: await unreadCounts(me._id),
            dm: await dmPulse(me),
            games: await gamePulse(me),
          });
        }
        case "comment_delete":
          return void res.status(200).json(await deleteComment(me, body.commentId, { asStaff: !!staff?.ok }));

        /* --------------------------------------------------------- follow */
        case "follow": {
          const r = await setFollow(me, body.id, body.follow !== false);
          return r ? void res.status(200).json(r) : void res.status(404).json({ error: "not_found" });
        }
        case "set_private":
          return void res.status(200).json(await setPrivate(me, body.on === true));
        case "follow_requests":
          return send(await listFollowRequests(me, typeof body.before === "number" ? body.before : undefined));
        case "follow_respond":
          return void res.status(200).json(await respondFollowRequest(me, body.id, body.accept !== false));
        case "accounts": {
          if (!staff?.ok) return void res.status(403).json({ error: "forbidden" });
          const seeds = await allSeeds();
          const real = viewer.user;
          const row = (u: any) => ({ id: u.anonId, name: u.nickname ?? "-", verified: !!u.verified || isOfficial(u), ...(u.official === true ? { official: true } : {}), pv: photoVer(u.profilePhotoFileId) });
          return send({ main: row(real), items: seeds.map(row), current: acting ? me.anonId : real.anonId });
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
        case "story_like":
          return void res.status(200).json(await setStoryLike(me, body.storyId, body.like !== false));
        case "story_reply":
          await replyToStory(me, body.storyId, body.text);
          return void res.status(200).json({ ok: true });
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
          if (!hasUnlimitedXp(me._id) && (me.relicBalance ?? 0) < 1) return void res.status(200).json({ status: "no_balance" });
          const target = await findRequestTarget(me._id, body.id);
          if (!target) return void res.status(200).json({ status: "unavailable" });
          await markMatchSeenById(me._id, target._id);
          const created = await createChatRequest(me._id, target._id, new Date(), "miniapp");
          if (created.status !== "created") return void res.status(200).json({ status: created.status });
          const delivered = await sendChatRequestToTarget(created.request, me, target);
          return void res.status(200).json({ status: delivered ? "sent" : "unavailable" });
        }

        /* ------------------------------------------------- direct messages */
        case "dm_overview":
          return send(await dmOverview(me));
        case "dm_open": {
          const t = await openThread(me, body.sid, body.since);
          return t ? send(t) : void res.status(404).json({ error: "not_found" });
        }
        case "dm_send":
          return send({ message: await dmSendText(me, body.sid, body.text, body.cid, botApi()) });
        case "dm_photo": {
          const r = await dmSendPhoto(me, body.sid, body.image, botApi() as any, body.cid);
          waitUntil(r.after);
          return send({ message: r.message });
        }
        case "dm_end":
          return void res.status(200).json(await endThread(me, body.sid, botApi()));
        case "gift_remove": {
          if (!staff?.ok || env.OWNER_ID === undefined || staff.id !== env.OWNER_ID) return void res.status(403).json({ error: "forbidden" });
          const r = await adminDeleteGift(typeof body.id === "string" ? body.id : "");
          if (!r) return void res.status(404).json({ error: "not_found" });
          await logAdminAction(staff.id, "gift_delete", `${r.ownerId}:${r.giftId}`).catch(() => {});
          return void res.status(200).json({ ok: true });
        }
        case "dm_delete":
          return void res.status(200).json({ ok: await deleteThreadForMe(me, body.sid) });
        case "official_send": {
          // Nava / a legal account writes to one person: no request, no XP, the person cannot answer
          if (!isOfficial(me)) return void res.status(403).json({ error: "forbidden" });
          const to: any = await findVisibleUser(me._id, body.id);
          if (!to || isOfficial(to)) return void res.status(404).json({ error: "not_found" });
          await sendOfficialMessage(botApi(), me._id, to._id, typeof body.text === "string" ? body.text : "");
          return void res.status(200).json({ ok: true });
        }
        case "dm_requests":
          return send(await listRequests(me));
        case "dm_respond":
          return void res.status(200).json(await respondRequest(me, body.id, body.accept !== false, botApi()));
        case "dm_cancel":
          return void res.status(200).json({ ok: await cancelRequest(me, body.id) });

        /* ------------------------------------------------- block / report / staff */
        case "block":
          await blockInApp(me, body.id, botApi());
          return void res.status(200).json({ ok: true });
        case "unblock":
          await unblockInApp(me, body.id);
          return void res.status(200).json({ ok: true });
        case "blocked_list":
          return send({ items: await listBlocked(me) });
        case "report":
          await reportInApp(me, body.id, { reason: body.reason, text: body.text, image: body.image }, botApi());
          return void res.status(200).json({ ok: true });
        case "mod": {
          if (!staff?.ok) return void res.status(403).json({ error: "forbidden" });
          const ops: StaffOp[] = ["ban", "unban", "verify", "unverify", "photo_remove", "badges", "reset_user"];
          if (!ops.includes(body.op as StaffOp)) return void res.status(400).json({ error: "bad_input" });
          return void res.status(200).json(await staffModerate(staff.id, body.id, body.op as StaffOp, botApi(), { badges: body.badges, reason: body.reason }));
        }

        /* ----------------------------------------------------------- games */
        case "game_lobby":
        case "game_create":
        case "game_join":
        case "game_state":
        case "game_roll":
        case "game_move":
        case "game_resign":
          return send(await handleGameAction(action, me, body));

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
