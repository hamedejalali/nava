import type { NavaContext } from "../bot-context.js";
import { env } from "../config/env.js";

/** Resolves a Telegram file_id to a real, publicly-fetchable HTTPS URL so
 *  an external service (Sightengine) can fetch it server-side without us
 *  uploading the raw bytes ourselves. */
export async function resolveFileUrl(ctx: NavaContext, fileId: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
}
