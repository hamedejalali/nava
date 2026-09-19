import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { searchUsers, resetUserToZero } from "../../db/models/user.js";
import { isOwner } from "./constants.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

const CB = {
  confirm: "admin:resetuser:confirm:", // + targetId
  cancel: "admin:resetuser:cancel",
};

export function registerAdminResetUser(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.resetUser) {
      await setAdminFlow(ctx.from!.id, { flow: "reset_user", stage: "await_query" });
      await ctx.reply("آیدی تلگرام، یوزرنیم تلگرام، یا @آیدی‌ناشناس کاربری که می‌خوای کاملاً ریست کنی رو بفرست:");
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "reset_user" || flow.stage !== "await_query") return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    const results = await searchUsers(text, 5);
    if (results.length === 0) {
      await ctx.reply("کاربری پیدا نشد.");
      return;
    }
    const target = results[0]!;
    await setAdminFlow(ctx.from!.id, null);

    await ctx.reply(
      `⚠️ مطمئنی می‌خوای اطلاعات @${target.anonId} (${target.telegramId}) رو کامل ریست کنی؟\n\n` +
        `این کار برگشت‌ناپذیره: نام مستعار، سن، جنسیت، استان/شهر، بیوگرافی، عکس، موجودی رلیک، وریفای، سطح و موقعیت مکانی همه پاک میشن و کاربر دقیقاً مثل یک کاربر تازه، از /start شروع می‌کنه.`,
      {
        reply_markup: inlineKeyboard([
          [
            glassButton("✅ بله، ریست کن", `${CB.confirm}${target.telegramId}`, "danger"),
            glassButton("❌ انصراف", CB.cancel, "primary"),
          ],
        ]),
      }
    );
  });

  composer.callbackQuery(CB.cancel, async (ctx) => {
    if (!isOwner(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("لغو شد.").catch(() => {});
  });

  composer.callbackQuery(new RegExp(`^${CB.confirm}(\\d+)$`), async (ctx) => {
    if (!isOwner(ctx)) return;
    const targetId = Number(ctx.match![1]);

    const updated = await resetUserToZero(targetId);
    await logAdminAction(ctx.from!.id, "reset_user", String(targetId));
    await ctx.answerCallbackQuery({ text: "ریست شد ✅" });

    if (!updated) {
      await ctx.editMessageText("کاربر پیدا نشد (شاید قبلاً حذف شده).").catch(() => {});
      return;
    }

    await ctx.editMessageText(`✅ اطلاعات کاربر ${targetId} کامل ریست شد.`).catch(() => {});
    await ctx.api
      .sendMessage(targetId, "🔄 اطلاعات حساب شما توسط ادمین ریست شد. لطفاً برای شروع دوباره /start رو بزنید.")
      .catch(() => {});
  });
}
