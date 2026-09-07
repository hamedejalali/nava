import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { env } from "../../config/env.js";
import { dictionary, requireLocked } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { createModerationRecord, decideModerationRecord, type ImageModerationDoc } from "../../db/models/imageModeration.js";
import { setProfilePhoto, getUser, type UserDoc } from "../../db/models/user.js";
import { checkImage } from "../../services/sightengine.js";
import { buildSupportButton } from "../support/index.js";
import { resolveFileUrl } from "../../services/telegramFiles.js";
import { deliverApprovedChatImage, notifyRejectedChatImage } from "../matching/chatImage.js";

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };

function adminCaption(user: UserDoc): string {
  return [
    `📸 درخواست تایید عکس پروفایل`,
    ``,
    `آیدی ناشناس: @${user.anonId}`,
    `آیدی تلگرام: ${user.telegramId}`,
    user.username ? `یوزرنیم: @${user.username}` : `یوزرنیم: ندارد`,
    `نیک‌نیم: ${user.nickname ?? "-"}`,
    `سن: ${user.age ?? "-"}`,
    `جنسیت: ${user.gender ? (GENDER_LABEL[user.gender] ?? user.gender) : "-"}`,
    `استان: ${user.province ?? "-"}`,
    `شهر: ${user.city ?? "-"}`,
  ].join("\n");
}

export function registerPhotoUpload(composer: Composer<NavaContext>) {
  composer.on("message:photo", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.activeChatSessionId || user.onboardingStep !== "COMPLETED") {
      return next(); // handled elsewhere (chat image) or not a valid context yet
    }
    if (env.ADMIN_IDS.length === 0) {
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.errors.generic);
      return;
    }

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;

    const fileUrl = await resolveFileUrl(ctx, largest.file_id);
    const check = await checkImage(fileUrl);

    if (!check.flagged) {
      // Safe (or service unavailable is treated as flagged, never as safe)
      // — auto-approve immediately, still logged for audit.
      await createModerationRecord({
        type: "profile_photo",
        senderId: user._id,
        fileId: largest.file_id,
        status: "approved",
        aiScore: check.score,
        aiClassification: check.classification,
      });
      await setProfilePhoto(user._id, largest.file_id);
      const t = dictionary(ctx.userLang);
      await ctx.reply(t.photo.approved);
      return;
    }

    const request = await createModerationRecord({
      type: "profile_photo",
      senderId: user._id,
      fileId: largest.file_id,
      status: "pending",
      aiScore: check.score,
      aiClassification: check.classification,
    });

    const keyboard = inlineKeyboard([
      [
        glassButton("تأیید عکس", `modimg:approve:${request._id}`, "success"),
        glassButton("عدم تأیید عکس", `modimg:reject:${request._id}`, "danger"),
      ],
    ]);

    for (const adminId of env.ADMIN_IDS) {
      await ctx.api.sendPhoto(adminId, largest.file_id, { caption: adminCaption(user), reply_markup: keyboard }).catch(() => {});
    }

    const t = dictionary(ctx.userLang);
    await ctx.reply(t.photo.submittedForReview);
  });
}

async function handleProfilePhotoDecision(ctx: NavaContext, doc: ImageModerationDoc, decision: "approved" | "rejected") {
  const targetUser = await getUser(doc.senderId);
  const targetLang = targetUser?.languageCode ?? "fa";
  const t = dictionary(targetLang);

  if (decision === "approved") {
    await setProfilePhoto(doc.senderId, doc.fileId);
    await ctx.api.sendMessage(doc.senderId, t.photo.approved).catch(() => {});
  } else {
    const rejectedText = requireLocked(targetLang, "photo.rejected", t.photo.rejected);
    const supportLabel = requireLocked(targetLang, "photo.supportButton", t.photo.supportButton);
    const supportBtn = await buildSupportButton(supportLabel);
    await ctx.api
      .sendMessage(doc.senderId, rejectedText, { reply_markup: supportBtn ? inlineKeyboard([[supportBtn]]) : undefined })
      .catch(() => {});
  }
}

export function registerImageModerationDecisions(composer: Composer<NavaContext>) {
  composer.callbackQuery(/^modimg:(approve|reject):(.+)$/, async (ctx) => {
    if (!env.ADMIN_IDS.includes(ctx.from!.id)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const decision = ctx.match![1] === "approve" ? "approved" : "rejected";
    const recordId = ctx.match![2]!;

    const result = await decideModerationRecord(recordId, decision, ctx.from!.id);
    await ctx.answerCallbackQuery();
    if (result.status !== "decided") return; // already decided — idempotent no-op

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

    const { doc } = result;
    if (doc.type === "profile_photo") {
      await handleProfilePhotoDecision(ctx, doc, decision);
    } else {
      if (decision === "approved") await deliverApprovedChatImage(ctx, doc);
      else await notifyRejectedChatImage(ctx, doc);
    }
  });
}
