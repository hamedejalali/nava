import { env } from "./env.js";

/** The bot's own @username (without "@"), used to build deep links
 *  (t.me/<username>?start=...). Set BOT_USERNAME in env if it ever
 *  differs from the default. */
export function botUsername(): string {
  return (env.BOT_USERNAME ?? "NavaChatBot").replace(/^@/, "");
}
