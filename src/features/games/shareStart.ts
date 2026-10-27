import type { Composer } from "grammy";
import { env } from "../../config/env.js";
import type { NavaContext } from "../../bot-context.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { inviteInfo } from "../../services/games/backgammonGames.js";

/**
 * A shared game link  t.me/<bot>?start=g_<gid>:
 *   1) the forced-join channels are checked first,
 *   2) then ONE glass button opens the mini-app straight on that table (?go=g_<gid>).
 * Somebody who has not registered yet still gets the button; inside the mini-app only the game link is reachable and
 * every other section says "register in the bot first" (guest mode), with a button that closes the app.
 *
 * v1.27: the HOST opening his own link no longer reads «دوستت تو رو دعوت کرده» — he gets «میز تو آماده‌ست» (or «بازی در جریانه»),
 * and a table that is gone / already taken says so instead of showing a dead button.
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
    let info: Awaited<ReturnType<typeof inviteInfo>>;
    try {
      info = await inviteInfo(m[1]!, ctx.from.id);
    } catch {
      info = { kind: "open", stake: 0, hostName: "" };
    }
    const btn = (text: string) => ({ inline_keyboard: [[{ text, web_app: { url }, style: "success" } as any]] });
    switch (info.kind) {
      case "missing":
        await ctx.reply("🎲 این میز دیگه وجود نداره؛ از دوستت بخواه یه میز جدید بسازه.");
        return;
      case "taken":
        await ctx.reply("🎲 این میز پر شده و بازی شروع شده.");
        return;
      case "mine":
        if (info.status === "waiting") await ctx.reply("🎲 میز تخته‌نرد تو آماده‌ست و منتظر حریفه.\nلینک رو برای دوستت بفرست؛ هر وقت اومد بازی شروع میشه.", { reply_markup: btn("🎲 رفتن به میز من") });
        else await ctx.reply("🎲 بازی تخته‌نرد تو در جریانه.", { reply_markup: btn("🎲 ادامه‌ی بازی") });
        return;
      default:
        await ctx.reply(
          `🎲 ${info.hostName ? `${info.hostName} تو رو` : "دوستت تو رو"} به یه دست تخته‌نرد دعوت کرده!` + (info.stake > 0 ? `\n🪙 ژتون روی میز: ${(info.stake * 2).toLocaleString("fa-IR")}` : "") + "\nبرای ورود به میز، دکمه‌ی زیر رو بزن.",
          { reply_markup: btn("🎲 ورود به بازی") },
        );
    }
  });
}
