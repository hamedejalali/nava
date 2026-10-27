import type { Api } from "grammy";
import { env } from "../../config/env.js";
import { escapeHtml } from "../../utils/html.js";
import { botApi } from "../miniapp.js";
import { SocialError, findVisibleUser, parsePid } from "./common.js";
import { signMedia } from "./media.js";
import { getPostItem } from "./posts.js";

/**
 * "Share" sends the REAL photo + caption into any Telegram chat (not just a link):
 * the bot stores a prepared inline message (Bot API 8.0 savePreparedInlineMessage) and the
 * Mini App opens Telegram's own chat picker with it (WebApp.shareMessage).
 */
type ShareApi = { raw: { savePreparedInlineMessage: (args: any) => Promise<{ id: string }> } };

function origin(): string | null {
  const base = env.NAVA_MINIAPP_URL;
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

function openButton(deepLink: string) {
  const bot = env.BOT_USERNAME?.replace(/^@/, "");
  return bot ? { inline_keyboard: [[{ text: "باز کردن در مویاگرام", url: `https://t.me/${bot}?startapp=${deepLink}` }]] } : undefined;
}

export async function prepareShare(viewer: any, input: { pid?: unknown; uid?: unknown }, deps: { api?: ShareApi } = {}): Promise<{ id: string }> {
  const api = (deps.api ?? (botApi() as unknown as ShareApi));
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let result: Record<string, unknown>;

  if (input.pid !== undefined) {
    const parsed = parsePid(input.pid);
    const item = parsed ? await getPostItem(viewer._id, input.pid) : null;
    if (!item) throw new SocialError("not_found");
    const name = item.owner.username ? `@${item.owner.username}` : item.owner.name;
    const caption = [`<b>${escapeHtml(name)}</b>`, item.caption ? escapeHtml(item.caption) : "", `❤️ ${item.likes}  💬 ${item.comments}`].filter(Boolean).join("\n\n").slice(0, 1000);
    const reply_markup = openButton(item.kind === "profile" ? `q_${item.owner.id}` : `p_${item.pid}`);
    if (item.kind === "profile") {
      const owner = await findVisibleUser(viewer._id, (parsed as any).anonId, { includeSelf: true });
      if (!owner?.profilePhotoFileId) throw new SocialError("not_found");
      result = { type: "photo", id, photo_file_id: owner.profilePhotoFileId, caption, parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) };
    } else {
      const o = origin();
      if (!o) throw new SocialError("share_unavailable");
      const url = `${o}/api/miniapp?m=${item.mediaId}&s=${signMedia(item.mediaId!)}`;
      result = { type: "photo", id, photo_url: url, thumbnail_url: url, caption, parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) };
    }
  } else {
    const owner = await findVisibleUser(viewer._id, input.uid, { includeSelf: true });
    if (!owner) throw new SocialError("not_found");
    const name = owner.miniUsername ? `@${owner.miniUsername}` : (owner.nickname ?? "-");
    const text = [`<b>${escapeHtml(name)}</b>`, owner.miniUsername ? escapeHtml(owner.nickname ?? "") : "", owner.bio ? escapeHtml(owner.bio) : ""].filter(Boolean).join("\n");
    const reply_markup = openButton(`u_${owner.anonId}`);
    if (owner.profilePhotoFileId) result = { type: "photo", id, photo_file_id: owner.profilePhotoFileId, caption: text.slice(0, 1000), parse_mode: "HTML", ...(reply_markup ? { reply_markup } : {}) };
    else result = { type: "article", id, title: name, input_message_content: { message_text: text, parse_mode: "HTML" }, ...(reply_markup ? { reply_markup } : {}) };
  }

  try {
    const prepared = await api.raw.savePreparedInlineMessage({ user_id: viewer._id, result, allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true });
    return { id: prepared.id };
  } catch (err) {
    console.error("[navagram] savePreparedInlineMessage failed:", err instanceof Error ? err.message : "unknown");
    throw new SocialError("share_unavailable");
  }
}
export type { Api };
