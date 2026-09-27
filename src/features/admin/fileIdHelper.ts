import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { isAdmin } from "./constants.js";

/**
 * Small, permanent admin utility — not a temporary hack — for whenever you
 * need a file_id (e.g. to set DEFAULT_PHOTO_MALE/FEMALE, or any other
 * "paste a file_id into env/DB" need later): send a photo to the bot with
 * the caption exactly "fileid" and it replies with the id instead of
 * treating the photo as a profile-photo upload. Admin-only, and it
 * intentionally returns (never calls next()) only when the caption
 * matches, so a normal profile-photo upload (no caption) is completely
 * unaffected and still goes to registerPhotoUpload as before.
 */
export function registerFileIdHelper(composer: Composer<NavaContext>) {
  composer.on("message:photo", async (ctx, next) => {
    if (!isAdmin(ctx) || ctx.message.caption?.trim().toLowerCase() !== "fileid") {
      return next();
    }
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    await ctx.reply(`file_id:\n<code>${largest.file_id}</code>`, { parse_mode: "HTML" });
  });
}
