import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getContent } from "../../db/models/content.js";
import { glassUrlButton, type GlassCallbackButton, type GlassUrlButton } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { DEFAULT_RULES } from "../admin/guides.js";

function supportUrl(raw: string): string {
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const username = raw.replace(/^@/, "");
  return `https://t.me/${username}`;
}

/** Builds the "آیدی پشتیبانی" button, or null if no support ID has been
 *  configured yet — callers must handle that (omit the button) rather than
 *  crash, per spec ("handle safely without crashing"). */
export async function buildSupportButton(label: string): Promise<GlassCallbackButton | GlassUrlButton | null> {
  const supportId = await getContent("supportId", "");
  if (!supportId) return null;
  return glassUrlButton(label, supportUrl(supportId), "primary", buttonIcon("SUPPORT"));
}

export function registerRulesCommand(composer: Composer<NavaContext>) {
  composer.command("ghavanin", async (ctx) => {
    const text = await getContent("rules", DEFAULT_RULES);
    await ctx.reply(text);
  });
}
