import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { getRequestRecipientIds } from "../admin/constants.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";
import { escapeHtml } from "../../utils/html.js";

/**
 * "پیشنهادات و انتقادات" — no support id is shown anymore. The user types
 * (or sends a photo with/without a caption) their feedback right here in
 * the bot, and it's forwarded straight to the owner with full context
 * about who sent it, so the owner never needs a separate support inbox.
 */

interface FeedbackFlowDoc {
  _id: number;
}

async function flowCollection() {
  const db = await getDb();
  return db.collection<FeedbackFlowDoc>("feedback_flow");
}

export async function isAwaitingFeedback(userId: number): Promise<boolean> {
  const col = await flowCollection();
  return !!(await col.findOne({ _id: userId }));
}

export async function sendFeedbackPrompt(ctx: NavaContext): Promise<void> {
  await clearAllUserFlows(ctx.from!.id);
  const col = await flowCollection();
  await col.updateOne({ _id: ctx.from!.id }, { $set: {} }, { upsert: true });
  await ctx.reply(
    "پیشنهاد یا انتقادت رو همینجا بنویس؛ مستقیم برای مدیریت ارسال میشه.\n\nمی‌تونی یه عکس هم (با کپشن یا بدون کپشن) بفرستی.",
    { reply_markup: cancelKeyboard() }
  );
}

function userInfoLines(ctx: NavaContext): string {
  const from = ctx.from!;
  const user = ctx.dbUser;
  const usernameLine = from.username ? `یوزرنیم: @${escapeHtml(from.username)}\n` : "";
  return (
    `فرستنده: ${escapeHtml(from.first_name)}${from.last_name ? " " + escapeHtml(from.last_name) : ""}\n` +
    usernameLine +
    `آیدی عددی: <code>${from.id}</code>\n` +
    `آیدی ناشناس: ${escapeHtml(user?.anonId ?? "-")}`
  );
}

export function registerFeedbackFlow(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!(await isAwaitingFeedback(ctx.from!.id))) return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await (await flowCollection()).deleteOne({ _id: ctx.from!.id });
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (text.length === 0 || text.length > 2000) {
      await ctx.reply("متن باید بین ۱ تا ۲۰۰۰ کاراکتر باشه.", { reply_markup: cancelKeyboard() });
      return;
    }

    await (await flowCollection()).deleteOne({ _id: ctx.from!.id });
    const body = `💬 پیشنهاد/انتقاد جدید\n\n${userInfoLines(ctx)}\n\n<blockquote>${escapeHtml(text)}</blockquote>`;
    for (const ownerId of await getRequestRecipientIds()) {
      await ctx.api.sendMessage(ownerId, body, { parse_mode: "HTML" }).catch(() => {});
    }
    await ctx.reply("✅ ممنون! پیامت ارسال شد.");
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!(await isAwaitingFeedback(ctx.from!.id))) return next();

    await (await flowCollection()).deleteOne({ _id: ctx.from!.id });
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    const caption = ctx.message.caption?.trim();
    const captionLine = caption ? `\n\n<blockquote>${escapeHtml(caption)}</blockquote>` : "";
    const body = `💬 پیشنهاد/انتقاد جدید (با عکس)\n\n${userInfoLines(ctx)}${captionLine}`;
    for (const ownerId of await getRequestRecipientIds()) {
      await ctx.api.sendPhoto(ownerId, largest.file_id, { caption: body, parse_mode: "HTML" }).catch(() => {});
    }
    await ctx.reply("✅ ممنون! پیامت ارسال شد.");
  });
}
