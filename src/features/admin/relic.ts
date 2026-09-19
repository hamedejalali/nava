import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { inlineKeyboard } from "../../ui/keyboard.js";
import { cancelButton } from "../../ui/cancelButton.js";
import { getUser } from "../../db/models/user.js";
import { adminAdjustBalance } from "../../db/models/relic.js";
import { getDb } from "../../db/connect.js";
import { isAdmin } from "./constants.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isFlowCancelSignal } from "./flowState.js";

const CB = { open: "admin:relic", cancel: "admin:relic:cancel" };
export { CB as RELIC_ADMIN_CALLBACKS };

// Tiny MongoDB-backed step tracker for this two-step admin flow
// (1: waiting for target Telegram ID, 2: waiting for +/- amount).
interface AdminRelicFlowDoc {
  _id: number;
  stage: "await_user" | "await_amount";
  targetId?: number;
}

async function setStep(adminId: number, step: { stage: "await_user" } | { stage: "await_amount"; targetId: number } | null) {
  const db = await getDb();
  const col = db.collection<AdminRelicFlowDoc>("admin_relic_flow");
  if (!step) {
    await col.deleteOne({ _id: adminId });
  } else {
    await col.updateOne({ _id: adminId }, { $set: { ...step } }, { upsert: true });
  }
}
async function getStep(adminId: number) {
  const db = await getDb();
  return db.collection<AdminRelicFlowDoc>("admin_relic_flow").findOne({ _id: adminId });
}

export function registerAdminRelic(composer: Composer<NavaContext>) {
  composer.callbackQuery(CB.open, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("آیدی عددی تلگرام کاربر مورد نظر رو بفرست:", {
      reply_markup: inlineKeyboard([[cancelButton("لغو", CB.cancel)]]),
    });
    await setStep(ctx.from!.id, { stage: "await_user" });
  });

  composer.callbackQuery(CB.cancel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await setStep(ctx.from!.id, null);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("لغو شد.").catch(() => {});
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();

    if (ctx.message.text.trim() === ADMIN_MENU_LABELS.relic) {
      await ctx.reply("آیدی عددی تلگرام کاربر مورد نظر رو بفرست:");
      await setStep(ctx.from!.id, { stage: "await_user" });
      return;
    }

    const step = await getStep(ctx.from!.id);
    if (!step) return next();

    if (isFlowCancelSignal(ctx.message.text)) {
      await setStep(ctx.from!.id, null);
      if (ctx.message.text.trim().startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    const raw = toAsciiDigits(ctx.message.text.trim());

    if (step.stage === "await_user") {
      const targetId = Number(raw);
      if (!Number.isInteger(targetId)) {
        await ctx.reply("آیدی معتبر نیست. یه عدد صحیح بفرست یا لغو کن.");
        return;
      }
      const target = await getUser(targetId);
      if (!target) {
        await ctx.reply("کاربری با این آیدی پیدا نشد.");
        return;
      }
      await setStep(ctx.from!.id, { stage: "await_amount", targetId });
      await ctx.reply(
        `کاربر: @${target.anonId} — موجودی فعلی: ${target.relicBalance ?? 0} رلیک\n\n` +
          `عدد مثبت برای افزودن، عدد منفی برای کسر بفرست (مثلاً 10 یا 10-):`,
        { reply_markup: inlineKeyboard([[cancelButton("لغو", CB.cancel)]]) }
      );
      return;
    }

    if (step.stage === "await_amount") {
      const delta = Number(raw.replace(/^\+/, ""));
      if (!Number.isInteger(delta) || delta === 0) {
        await ctx.reply("عدد معتبر نیست. یه عدد صحیح غیرصفر بفرست یا لغو کن.");
        return;
      }

      const result = await adminAdjustBalance(ctx.from!.id, step.targetId!, delta, "manual_admin_adjustment");
      await setStep(ctx.from!.id, null);

      if (result.status === "insufficient") {
        await ctx.reply("موجودی کاربر برای این مقدار کسر کافی نیست.");
        return;
      }
      if (result.status === "invalid") {
        await ctx.reply("درخواست نامعتبر بود.");
        return;
      }

      await ctx.reply(`✅ انجام شد. موجودی جدید: ${result.newBalance} رلیک`);
      await ctx.api
        .sendMessage(step.targetId!, delta > 0 ? `💰 ${delta} رلیک به حساب شما اضافه شد.` : `⚠️ ${-delta} رلیک از حساب شما کسر شد.`)
        .catch(() => {});
    }
  });
}
