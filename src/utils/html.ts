/** Escapes text for Telegram's HTML parse mode (only & < > need escaping).
 *  ALWAYS wrap user-controlled values (nickname, bio, first name, report
 *  reason, ...) with this when the message is sent with parse_mode "HTML" —
 *  otherwise a single "<" typed by a user makes Telegram reject the whole
 *  message ("can't parse entities"). */
export function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
