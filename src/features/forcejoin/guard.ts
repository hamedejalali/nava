import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, glassUrlButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon, textEmoji } from "../../config/emojis.js";
import { listActiveChannels, type RequiredChannelDoc } from "../../db/models/channel.js";
import { escapeHtml } from "../../utils/html.js";
import { FORCE_JOIN_VERIFY_CALLBACK } from "./constants.js";

/** Checks the user's live Telegram membership for every required channel.
 *  Never cached — re-verified on every gated action, per spec ("do not
 *  permanently assume membership"). A Telegram API failure for a given
 *  channel is treated as "not a member" (fail closed) rather than silently
 *  granting access, and is logged rather than crashing the request. */
export async function isMemberOfAll(ctx: NavaContext, channels: RequiredChannelDoc[]): Promise<boolean> {
  const userId = ctx.from!.id;

  for (const channel of channels) {
    try {
      const member = await ctx.api.getChatMember(channel.chatRef, userId);
      const joined = member.status === "member" || member.status === "administrator" || member.status === "creator";
      if (!joined) return false;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[forceJoin] getChatMember failed for channel ${channel._id} (${channel.chatRef}):`, err);
      return false;
    }
  }
  return true;
}

function buildChannelLines(channels: RequiredChannelDoc[]): string {
  return channels.map((c) => `${textEmoji("CHANNEL", "📣")} ${escapeHtml(c.handle)}`).join("\n");
}

function buildForceJoinKeyboard(channels: RequiredChannelDoc[], verifyLabel: string) {
  const channelButtons = channels.map((c, index) =>
    glassUrlButton(c.title, c.url, index % 2 === 0 ? "primary" : "danger", buttonIcon("CHANNEL"))
  );
  const channelRows = [];
  for (let i = 0; i < channelButtons.length; i += 2) {
    channelRows.push(channelButtons.slice(i, i + 2));
  }

  const verifyRow = [glassButton(verifyLabel, FORCE_JOIN_VERIFY_CALLBACK, "success", buttonIcon("GREEN_CHECK"))];
  return inlineKeyboard([...channelRows, verifyRow]);
}

export async function sendForceJoinScreen(ctx: NavaContext, lang: Language, channels: RequiredChannelDoc[]): Promise<void> {
  const t = dictionary(lang);
  const nickname = ctx.dbUser?.nickname ?? ctx.from?.first_name ?? "";

  const intro = requireLocked(lang, "forceJoin.messageIntro", t.forceJoin.messageIntro)(escapeHtml(nickname));
  const outro = requireLocked(lang, "forceJoin.messageOutro", t.forceJoin.messageOutro);
  const verifyLabel = requireLocked(lang, "forceJoin.verifyButton", t.forceJoin.verifyButton);

  const text = `${intro}\n\n${buildChannelLines(channels)}\n\n${outro}`;

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: buildForceJoinKeyboard(channels, verifyLabel) });
}

/**
 * Main guard used before any restricted action. Returns true when the user
 * may proceed (no active required channels, user is exempt via /Exempt, or
 * live verification confirms membership in all of them). Otherwise sends
 * the force-join screen and returns false.
 */
export async function requireChannelMembership(ctx: NavaContext, lang: Language): Promise<boolean> {
  if (ctx.dbUser?.channelsExempt) return true;

  const channels = await listActiveChannels();
  if (channels.length === 0) return true;

  const ok = await isMemberOfAll(ctx, channels);
  if (ok) return true;

  await sendForceJoinScreen(ctx, lang, channels);
  return false;
}
