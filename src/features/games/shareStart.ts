import type { Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { requireChannelMembership } from "../forcejoin/guard.js";

/**
 * A shared game link  t.me/<bot>?start=g_<gid>:
 *   1) the forced-join channels are checked first,
 *   2) then ONE glass button opens the mini-app straight on that table (?go=g_<gid>).
 * Somebody who has not registered yet still gets the button; inside the mini-app only the game link is reachable and
 * every other section says "register in the bot first" (guest mode), with a button that closes the app.
 */
export const GAME_START_RE = /^g_([A-Za-z0-9_-]{4,16})$/;

export function gameAppUrl(gid: string): string | null {
  const base = env.NAVA_MINIAPP_URL;
  if (!base) return null;
  try {
    const u = new URL(base);
    u.searchParams.set("go", `g_${gid}`);
    return u.toString();
  } catch {
    return null;
  }
}

export function registerGameShareStart(composer: Composer<NavaContext>) {
  composer.command("start", async (ctx, next) => {
    const m = GAME_START_RE.exec(ctx.match?.trim() ?? "");
    if (!m || !ctx.from) return next();
    if (!(await requireChannelMembership(ctx, ctx.userLang))) return;
    const url = gameAppUrl(m[1]!);
    if (!url) {
      await ctx.reply("🎲 بازی الان در دسترس نیست.");
      return;
    }
    await ctx.reply("🎲 دوستت تو رو به یه دست تخته‌نرد دعوت کرده!\nبرای ورود به میز، دکمه‌ی زیر رو بزن.", {
      reply_markup: { inline_keyboard: [[{ text: "🎲 ورود به بازی", web_app: { url }, style: "success" } as any]] },
    });
  });
}
