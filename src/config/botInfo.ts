import { env } from "./env.js";

let learned: string | null = null;

/** Remembers the bot's real @username (from Telegram's getMe / ctx.me) so links never depend on a hand-set variable. */
export function rememberBotUsername(name: string | null | undefined): void {
  const n = name?.replace(/^@/, "").trim();
  if (n) learned = n;
}

/** The bot's own @username (without "@"), used to build deep links (t.me/<username>?start=...).
 *  Order: BOT_USERNAME (if set) → what Telegram told us (getMe) → legacy default. */
export function botUsername(): string {
  return (env.BOT_USERNAME ?? learned ?? "NavaChatBot").replace(/^@/, "");
}
