import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { searchUsers, setAdminRole } from "../../db/models/user.js";
import { isOwner } from "./constants.js";
import { setAdminFlow, getAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

export function registerAdminModerators(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.moderators) {
      await setAdminFlow(ctx.from!.id, { flow: "moderators", stage: "await_query" });
      await ctx.reply(
        "آیدی تلگرام یا @آیدی‌ناشناس کاربر رو بفرست.\n" +
          "بعدش می‌تونی «افزودن» یا «حذف» ادمین رو انتخاب کنی."
      );
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "moderators") return next();

    if (flow.stage === "await_query") {
      const results = await searchUsers(text, 5);
      if (results.length === 0) {
        await ctx.reply("کاربری پیدا نشد.");
        return;
      }
      const target = results[0]!;
      await setAdminFlow(ctx.from!.id, { flow: "moderators", stage: "await_action", data: { targetId: target._id } });
      await ctx.reply(
        `کاربر: @${target.anonId} — ادمین فعلاً: ${target.isAdmin ? "✅" : "❌"}\n\n` +
          `بفرست: «افزودن» برای دادن دسترسی ادمین، یا «حذف» برای گرفتنش`
      );
      return;
    }

    if (flow.stage === "await_action") {
      const targetId = flow.data?.targetId as number;
      if (text === "افزودن") {
        await setAdminRole(targetId, true);
        await logAdminAction(ctx.from!.id, "grant_admin", String(targetId));
        await ctx.reply("✅ دسترسی ادمین داده شد.");
        await ctx.api.sendMessage(targetId, "🛡️ شما به عنوان ادمین ربات نوا منصوب شدید.").catch(() => {});
      } else if (text === "حذف") {
        await setAdminRole(targetId, false);
        await logAdminAction(ctx.from!.id, "revoke_admin", String(targetId));
        await ctx.reply("✅ دسترسی ادمین گرفته شد.");
        await ctx.api.sendMessage(targetId, "⚠️ دسترسی ادمین شما در ربات نوا لغو شد.").catch(() => {});
      } else {
        await ctx.reply('لطفاً "افزودن" یا "حذف" رو بفرست.');
        return;
      }
      await setAdminFlow(ctx.from!.id, null);
    }
  });
}
