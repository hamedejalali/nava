import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { isAdmin } from "./constants.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { banUser } from "../../services/banCleanup.js";
import { C, col } from "../../services/nava/common.js";
import { PR, clearReports } from "../../services/nava/postReports.js";
import { removePost, type PostDoc } from "../../services/nava/posts.js";
import { botApi } from "../../services/miniapp.js";

/** Owner / admin decisions on a reported Mini App post. */
export function registerPostReportsAdmin(composer: Composer<NavaContext>) {
  const re = (p: string) => new RegExp(`^${p}([A-Za-z0-9_-]{6,24})$`);
  const done = async (ctx: NavaContext, text: string) => {
    await ctx.answerCallbackQuery({ text });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
  };

  composer.callbackQuery(re(PR.ignore), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await clearReports(ctx.match![1]!);
    await logAdminAction(ctx.from!.id, "post_report_ignore", ctx.match![1]!);
    await done(ctx, "گزارش‌ها پاک شد");
  });

  const remove = async (ctx: NavaContext, ban: boolean) => {
    const id = (ctx.match as RegExpMatchArray)[1]!;
    const post = (await (await col<PostDoc>(C.posts)).findOne({ _id: id } as any)) as PostDoc | null;
    if (!post) return void (await done(ctx, "این پست دیگه وجود نداره"));
    await removePost(post);
    await clearReports(id);
    await logAdminAction(ctx.from!.id, ban ? "post_report_delete_ban" : "post_report_delete", `${id}:${post.ownerId}`);
    if (ban) await banUser(ctx.api, post.ownerId, "انتشار محتوای نامناسب");
    else await botApi().sendMessage(post.ownerId, "⚠️ یکی از پست‌هات به‌خاطر نقض قوانین توسط مدیریت حذف شد.").catch(() => {});
    await done(ctx, ban ? "پست حذف و کاربر بن شد" : "پست حذف شد");
  };
  composer.callbackQuery(re(PR.del), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await remove(ctx, false);
  });
  composer.callbackQuery(re(PR.ban), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await remove(ctx, true);
  });
}
