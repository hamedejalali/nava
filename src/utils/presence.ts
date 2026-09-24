/**
 * Telegram's Bot API has NO access to a user's real online/offline status
 * or "last seen" inside Telegram itself — that data only exists over
 * MTProto, for user accounts, never for bots (an intentional Telegram
 * platform restriction, not a limitation of this codebase). The closest
 * honest substitute is the user's last activity WITH THIS BOT
 * (`lastActivityAt`), which is what this formats.
 */
const ONLINE_WINDOW_MS = 3 * 60 * 1000; // "recently active" = last 3 minutes

export function formatPresenceFa(lastActivityAt: Date | undefined): string {
  if (!lastActivityAt) return "⚪️ آخرین بازدید: نامشخص";
  const diffMs = Date.now() - new Date(lastActivityAt).getTime();
  if (diffMs <= ONLINE_WINDOW_MS) return "🟢 آنلاین";

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `⚪️ آخرین بازدید: ${minutes} دقیقه پیش`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `⚪️ آخرین بازدید: ${hours} ساعت پیش`;

  const days = Math.floor(hours / 24);
  return `⚪️ آخرین بازدید: ${days} روز پیش`;
}
