import { signMedia } from "./media.js";

/**
 * HTTP-layer presenter: turns the internal ids of every API answer into ready-to-use, signed image URLs,
 * so the Mini App can use plain <img src> (browser cache, lazy loading) and never needs a Telegram id,
 * a bot token or a file_id.
 *
 *   mediaId        -> src     /api/miniapp?m=<mediaId>&s=<sig>
 *   coverMediaId   -> cover   (highlight cover)
 *   pv  (+ owner id) -> av    avatar of a user     /api/miniapp?u=<anonId>&v=<version>&s=<sig>
 *   pv  (pid "pp:…") -> src   the profile-photo post's picture
 *   tilePv         -> tileSrc (Explore tile that falls back to the profile photo)
 *
 * The signature is an HMAC derived from the bot token, so a URL can only come from this server.
 */

export function mediaUrl(mediaId: string): string {
  return `/api/miniapp?m=${encodeURIComponent(mediaId)}&s=${signMedia(mediaId)}`;
}
export function avatarUrl(anonId: string, version: string): string {
  return `/api/miniapp?u=${encodeURIComponent(anonId)}&v=${encodeURIComponent(version)}&s=${signMedia(`u:${anonId}`)}`;
}

export function present<T = unknown>(value: unknown): T {
  return walk(value) as T;
}

function walk(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(walk);
  if (!x || typeof x !== "object" || x instanceof Date || Buffer.isBuffer(x)) return x;
  const o = x as Record<string, unknown>;
  const profilePost = typeof o.pid === "string" && o.pid.startsWith("pp:");
  const anon = profilePost ? (o.pid as string).slice(3) : typeof o.id === "string" ? o.id : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "mediaId") {
      if (typeof v === "string") out.src = mediaUrl(v);
      else if (!("src" in out)) out.src = null;
    } else if (k === "coverMediaId") {
      out.cover = typeof v === "string" ? mediaUrl(v) : null;
    } else if (k === "pv") {
      if (typeof v === "string" && anon) out[profilePost ? "src" : "av"] = avatarUrl(anon, v);
      else if (!profilePost && typeof o.id === "string") out.av = null;
    } else if (k === "tilePv") {
      out.tileSrc = typeof v === "string" && anon ? avatarUrl(anon, v) : null;
    } else {
      out[k] = walk(v);
    }
  }
  return out;
}
