import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { createReport, getReport, decideReportOnce } from "../../db/models/reports.js";
import { grantReportRewardOnce } from "../../db/models/relic.js";
import { getAllAdminIds, isOwner } from "../admin/constants.js";
import { getContent } from "../../db/models/content.js";
import { getUser } from "../../db/models/user.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { textEmoji } from "../../config/emojis.js";
import { escapeHtml } from "../../utils/html.js";

interface ReportFlowDoc {
  _id: number; // reporter's telegram id
  stage: "await_reason" | "await_photo";
  targetId: number;
  reason?: string;
}

async function setFlow(reporterId: number, flow: ReportFlowDoc | null): Promise<void> {
  const db = await getDb();
  const col = db.collection<ReportFlowDoc>("report_flow");
  if (!flow) {
    await col.deleteOne({ _id: reporterId });
  } else {
    await col.replaceOne({ _id: reporterId }, flow, { upsert: true });
  }
}
async function getFlow(reporterId: number): Promise<ReportFlowDoc | null> {
  const db = await getDb();
  return db.collection<ReportFlowDoc>("report_flow").findOne({ _id: reporterId });
}

const DECISION_CB = {
  approve: "admin:report:approve:", // + reportId
  reject: "admin:report:reject:", // + reportId
};

function reportIdentityBlock(reporterId: number, reporterAnonId: string, reporterUsername: string | undefined, target: { anonId: string; telegramId: number }, targetUsername: string | undefined) {
  return (
    `گزارش‌دهنده:\n` +
    `• یوزرنیم تلگرام: ${reporterUsername ? "@" + reporterUsername : "-"}\n` +
    `• آیدی نوا: <code>${reporterAnonId}</code>\n` +
    `• آیدی عددی: <code>${reporterId}</code>\n\n` +
    `گزارش‌شده:\n` +
    `• یوزرنیم تلگرام: ${targetUsername ? "@" + targetUsername : "-"}\n` +
    `• آیدی نوا: <code>${target.anonId}</code>\n` +
    `• آیدی عددی: <code>${target.telegramId}</code>`
  );
}

export function registerReportFlow(composer: Composer<NavaContext>) {
  // Step 1: tap "🚫 گزارش کاربر" — ask for a reason.
  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.report}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_reason", targetId });
    await ctx.reply("دلیل گزارشت رو دقیق بنویس (اگه لازم بود بعدش می‌تونی مدرک/عکس هم بفرستی):");
  });

  // Step 2: reason text.
  composer.on("message:text", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_reason") return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (text.length < 3) {
      await ctx.reply("لطفاً دلیل گزارش رو کمی کامل‌تر بنویس.");
      return;
    }

    await setFlow(ctx.from!.id, { ...flow, stage: "await_photo", reason: text });
    await ctx.reply("اگه عکس یا مدرکی داری همینجا بفرست، وگرنه بنویس «ندارم».");
  });

  // Step 3: optional photo, or "ندارم" text — finalizes the report.
  composer.on("message:text", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_photo") return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (text !== "ندارم") {
      await ctx.reply("اگه عکس داری بفرستش، یا دقیقاً بنویس «ندارم».");
      return;
    }

    await finalizeReport(ctx, flow, undefined);
  });

  composer.on("message:photo", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_photo") return next();

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    await finalizeReport(ctx, flow, largest.file_id);
  });

  composer.callbackQuery(new RegExp(`^${DECISION_CB.approve}(.+)$`), async (ctx) => decide(ctx, ctx.match![1]!, "approved"));
  composer.callbackQuery(new RegExp(`^${DECISION_CB.reject}(.+)$`), async (ctx) => decide(ctx, ctx.match![1]!, "rejected"));
}

async function finalizeReport(ctx: NavaContext, flow: ReportFlowDoc, photoFileId: string | undefined) {
  await setFlow(ctx.from!.id, null);

  const target = await getUser(flow.targetId);
  if (!target) {
    await ctx.reply("این کاربر دیگه در دسترس نیست.");
    return;
  }

  const report = await createReport(ctx.from!.id, flow.targetId, ctx.dbUser?.activeChatSessionId, flow.reason, photoFileId);
  await ctx.reply("✅ گزارش شما ثبت و برای بررسی ارسال شد، ممنون از همکاریت 🙏");

  const identity = reportIdentityBlock(ctx.from!.id, ctx.dbUser?.anonId ?? "-", ctx.from?.username, target, undefined);
  const caption =
    `⚠️ گزارش جدید\n\n${identity}\n\n` + `دلیل: ${escapeHtml((flow.reason ?? "").slice(0, 600))}\n` + `شناسه گزارش: <code>${report._id}</code>`;

  const decisionKb = inlineKeyboard([
    [
      glassButton("✅ تایید (۵ رلیک پاداش)", `${DECISION_CB.approve}${report._id}`, "success"),
      glassButton("❌ رد", `${DECISION_CB.reject}${report._id}`, "danger"),
    ],
  ]);

  for (const adminId of await getAllAdminIds()) {
    if (photoFileId) {
      await ctx.api.sendPhoto(adminId, photoFileId, { caption, parse_mode: "HTML", reply_markup: decisionKb }).catch(() => {});
    } else {
      await ctx.api.sendMessage(adminId, caption, { parse_mode: "HTML", reply_markup: decisionKb }).catch(() => {});
    }
  }
}

async function decide(ctx: NavaContext, reportId: string, decision: "approved" | "rejected") {
  if (!isOwner(ctx)) {
    // Regular (non-owner) admins can see reports but only the owner
    // decides — per "مالک بررسی کرد" in the spec.
    await ctx.answerCallbackQuery({ text: "فقط مالک ربات می‌تونه این گزارش رو تایید/رد کنه." });
    return;
  }

  const report = await decideReportOnce(reportId, decision, ctx.from!.id);
  if (!report) {
    await ctx.answerCallbackQuery({ text: "این گزارش قبلاً بررسی شده." });
    return;
  }
  await ctx.answerCallbackQuery();

  const decisionLabel = decision === "approved" ? "✅ تایید شد" : "❌ رد شد";
  const cbMessage = ctx.callbackQuery?.message;
  if (cbMessage && "caption" in cbMessage && cbMessage.caption) {
    await ctx.editMessageCaption({ caption: `${cbMessage.caption}\n\n${decisionLabel}` }).catch(() => {});
  } else {
    await ctx.editMessageText(`${decisionLabel}`).catch(() => {});
  }

  if (decision === "approved") {
    const rewarded = await grantReportRewardOnce(report.reporterId, report._id);
    const relicEmoji = textEmoji("RELIC", "💰");
    if (rewarded) {
      await ctx.api
        .sendMessage(report.reporterId, `✅ گزارش شما بررسی و تایید شد.\n${relicEmoji} ۵ رلیک به‌عنوان پاداش به حساب شما اضافه شد.`)
        .catch(() => {});
    }
  } else {
    const supportId = await getContent("supportId", "");
    const supportLine = supportId ? `\n\nاگر مستندات کامل‌تری داری، به آیدی پشتیبانی پیام بده: ${supportId}` : "";
    await ctx.api
      .sendMessage(report.reporterId, `❌ مستندات شما کافی نبود و گزارش تایید نشد.${supportLine}`)
      .catch(() => {});
  }
}
