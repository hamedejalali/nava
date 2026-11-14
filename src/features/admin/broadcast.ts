import { cancelKeyboard } from "../common/userFlows.js";
import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { createBroadcastJob, getBroadcastJob } from "../../db/models/broadcast.js";
import { processBroadcastBatch } from "../../services/broadcastProcessor.js";
import { isAdmin } from "./constants.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { emojiSyntaxToHtml } from "../../services/emojiSyntax.js";

const CB = { confirm: "admin:broadcast:confirm", cancel: "admin:broadcast:cancel" };

export function registerAdminBroadcast(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.broadcast) {
      await setAdminFlow(ctx.from!.id, { flow: "broadcast", stage: "await_text" });
      await ctx.reply("متن پیام همگانی رو بفرست:", { reply_markup: cancelKeyboard() });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "broadcast" || flow.stage !== "await_text") return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    await setAdminFlow(ctx.from!.id, { flow: "broadcast", stage: "confirm", data: { message: text } });

    // v1.31.0: the PREVIEW is the message itself exactly as users will see it (emoji syntax + real newlines), with the confirmation under it
    await ctx.reply(emojiSyntaxToHtml(text), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [glassButton("✅ تأیید و ارسال برای همه", CB.confirm, "success"), glassButton("❌ لغو", CB.cancel, "danger")],
      ]),
    });
  });

  composer.callbackQuery(CB.cancel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await setAdminFlow(ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("لغو شد.").catch(() => {});
  });

  composer.callbackQuery(CB.confirm, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "broadcast" || flow.stage !== "confirm") {
      await ctx.answerCallbackQuery();
      return;
    }

    const message = flow.data?.message as string;
    await setAdminFlow(ctx.from!.id, null);

    const job = await createBroadcastJob(message, ctx.from!.id);
    await logAdminAction(ctx.from!.id, "broadcast_created", job._id);

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.reply("⏳ ارسال شروع شد؛ گزارش کامل در کانال لاگ ثبت می‌شه.");

    await processBroadcastBatch(ctx.api, job);
    const updated = await getBroadcastJob(job._id);

    await ctx.reply(
      updated?.done
        ? `✅ پیام همگانی تموم شد. ارسال موفق: ${updated.sentCount} — ناموفق: ${updated.failCount}`
        : `📤 ${updated?.sentCount ?? 0} نفر تا الان ارسال شد. ادامه‌ی ارسال خودکاره و با کران روزانه (هر روز حدود ۰۴:۳۰ به وقت تهران) انجام می‌شه؛ ممکنه تا اون موقع منتظر بمونه.`
    );
  });
}
