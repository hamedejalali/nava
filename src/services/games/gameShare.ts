import { escapeHtml } from "../../utils/html.js";
import { botUsername } from "../../config/botInfo.js";
import { getAppVar, APP_VAR_KEYS } from "../appVars.js";
import { botApi } from "../miniapp.js";
import { SocialError } from "../nava/common.js";
import { shareInfo } from "./backgammonGames.js";

type ShareApi = { raw: { savePreparedInlineMessage: (args: any) => Promise<{ id: string }> } };

/**
 * «📤 دعوت دوست» — like sharing a post: Telegram's own chat picker opens with a ready message
 * (photo from the admin panel + caption + glass button). The button is a normal https://t.me/<bot>?start=g_<gid> link, so a
 * friend who never started the bot goes through the usual start → forced-join → «open the game» steps.
 */
export async function prepareGameShare(me: any, gid: unknown, deps: { api?: ShareApi; bot?: string } = {}): Promise<{ id: string; link: string }> {
  const info = await shareInfo(me, gid);
  const api = deps.api ?? (botApi() as unknown as ShareApi);
  const bot = (deps.bot ?? botUsername()).replace(/^@/, "");
  const link = `https://t.me/${bot}?start=g_${info.gid}`;
  const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const caption = [
    "🎲 <b>یه دست تخته‌نرد با من بازی می‌کنی؟</b>",
    info.stake > 0 ? `🪙 ژتون روی میز: ${(info.stake * 2).toLocaleString("fa-IR")}` : "🤝 بازی دوستانه",
    "برای ورود به میز دکمه‌ی زیر رو بزن 👇",
  ].join("\n\n");
  const reply_markup = { inline_keyboard: [[{ text: "🎲 ورود به میز", url: link }]] };
  const photo = await getAppVar(APP_VAR_KEYS.GAME_SHARE_PHOTO);
  const result: Record<string, unknown> = photo
    ? { type: "photo", id, photo_file_id: photo, caption, parse_mode: "HTML", reply_markup }
    : { type: "article", id, title: "🎲 دعوت به تخته‌نرد", input_message_content: { message_text: caption + `\n\n${escapeHtml(link)}`, parse_mode: "HTML" }, reply_markup };
  try {
    const prepared = await api.raw.savePreparedInlineMessage({ user_id: me._id, result, allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true });
    return { id: prepared.id, link };
  } catch (err) {
    // a stale/invalid photo file_id must never kill sharing: retry as plain text
    if (photo) {
      try {
        const fallback = { type: "article", id, title: "🎲 دعوت به تخته‌نرد", input_message_content: { message_text: caption + `\n\n${escapeHtml(link)}`, parse_mode: "HTML" }, reply_markup };
        const prepared = await api.raw.savePreparedInlineMessage({ user_id: me._id, result: fallback, allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true });
        return { id: prepared.id, link };
      } catch {
        /* fall through */
      }
    }
    console.error("[game-share] savePreparedInlineMessage failed:", err instanceof Error ? err.message : "unknown");
    throw new SocialError("share_unavailable");
  }
}
