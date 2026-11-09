import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { dictionary, requireLocked } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { createModerationRecord, decideModerationRecord, revokeAppliedRecord, type ImageModerationDoc } from "../../db/models/imageModeration.js";
import { setProfilePhoto, getUser, removeProfilePhotoIfCurrent, type UserDoc } from "../../db/models/user.js";
import { checkImage, type ModerationCheckResult } from "../../services/sightengine.js";
import { buildSupportButton } from "../support/index.js";
import {  isAdmin } from "../admin/constants.js";
import { getRecipients } from "../../services/channelRouting.js";
import { getDb } from "../../db/connect.js";
import { hasPendingPhotoFlow } from "../common/userFlows.js";
import { resolveFileUrl } from "../../services/telegramFiles.js";

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };

export function adminCaption(user: UserDoc): string {
  return [
    `📸 درخواست تایید عکس پروفایل`,
    ``,
    `آیدی ناشناس: ${user.anonId}`,
    `آیدی تلگرام: ${user.telegramId}`,
    user.username ? `یوزرنیم: @${user.username}` : `یوزرنیم: ندارد`,
    `نیک‌نیم: ${user.nickname ?? "-"}`,
    `سن: ${user.age ?? "-"}`,
    `جنسیت: ${user.gender ? (GENDER_LABEL[user.gender] ?? user.gender) : "-"}`,
    `استان: ${user.province ?? "-"}`,
    `شهر: ${user.city ?? "-"}`,
  ].join("\n");
}

/** Shown to the person when staff take a photo back (v1.29.0). */
export const PHOTO_REVOKED_TEXT = "⚠️ به دلیل عدم رعایت قوانین، عکس پروفایل شما حذف شد. می‌تونید عکس جدیدی بذارید.";

/** v1.29.0 — a profile photo needs NOBODY's approval any more: it is live the moment it arrives. This writes the audit record and
 *  sends the staff a copy (management channel / owner) with ONE glass button, «عدم تأیید عکس»: pressing it removes the photo and
 *  tells the person why. There is deliberately no approve button. Never throws (a failed log must not undo the user's upload). */
export async function announceLivePhoto(
  api: { sendPhoto: (chatId: number, photo: string, other?: any) => Promise<unknown> },
  user: UserDoc,
  fileId: string,
  check: Pick<ModerationCheckResult, "flagged" | "score" | "classification"> | null,
  recipients?: number[],
): Promise<void> {
  try {
    const record = await createModerationRecord({
      type: "profile_photo",
      senderId: user._id,
      fileId,
      status: "approved",
      appliedAtOnce: true,
      aiScore: check?.score,
      aiClassification: check?.classification,
    });
    const to = recipients ?? (await getRecipients("photo"));
    const keyboard = inlineKeyboard([[glassButton("عدم تأیید عکس", `modimg:reject:${record._id}`, "danger")]]);
    const note = check?.flagged ? "\n\n🚩 بررسی خودکار این عکس را مشکوک علامت زد یا انجام نشد؛ یک نگاه بنداز." : "";
    const caption = `${adminCaption(user).replace("📸 درخواست تایید عکس پروفایل", "📸 عکس پروفایل جدید (فوراً فعال شد)")}${note}`.slice(0, 1024);
    for (const adminId of to) {
      await api.sendPhoto(adminId, fileId, { caption, reply_markup: keyboard }).catch(() => {});
    }
  } catch (err) {
    console.error("[photo] staff copy failed:", err instanceof Error ? err.message : "unknown");
  }
}

export function registerPhotoUpload(composer: Composer<NavaContext>) {
  composer.on("message:photo", async (ctx, next) => {
    const user = ctx.dbUser;
    if (!user || user.activeChatSessionId || user.onboardingStep !== "COMPLETED") {
      return next(); // handled elsewhere (chat image) or not a valid context yet
    }
    // Verification selfie / report evidence are handled by their own flows.
    if (await hasPendingPhotoFlow(user._id)) return next();
    // the «🖼 عکس پروفایل» step of the edit menu is over once the photo arrives
    await (await getDb()).collection("profile_edit_flow").deleteOne({ _id: user._id as never, awaiting: "photo" } as never).catch(() => {});

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;

    // live at once; the automatic check only decides how the staff copy is worded
    let check: ModerationCheckResult | null = null;
    try {
      check = await checkImage(await resolveFileUrl(ctx, largest.file_id));
    } catch {
      check = null;
    }
    await setProfilePhoto(user._id, largest.file_id);
    const t = dictionary(ctx.userLang);
    await ctx.reply(t.photo.approved);
    await announceLivePhoto(ctx.api, user, largest.file_id, check);
  });
}

async function handleProfilePhotoDecision(ctx: NavaContext, doc: ImageModerationDoc, decision: "approved" | "rejected") {
  const targetUser = await getUser(doc.senderId);
  const targetLang = targetUser?.languageCode ?? "fa";
  const t = dictionary(targetLang);

  if (decision === "approved") {
    await setProfilePhoto(doc.senderId, doc.fileId);
    await ctx.api.sendMessage(doc.senderId, t.photo.approved).catch(() => {});
    return;
  }
  // a photo that was already live is taken back (only if it is still THE current one); an old waiting request never went live
  await removeProfilePhotoIfCurrent(doc.senderId, doc.fileId);
  const rejectedText = doc.appliedAtOnce ? PHOTO_REVOKED_TEXT : requireLocked(targetLang, "photo.rejected", t.photo.rejected);
  const supportLabel = requireLocked(targetLang, "photo.supportButton", t.photo.supportButton);
  const supportBtn = await buildSupportButton(supportLabel);
  await ctx.api.sendMessage(doc.senderId, rejectedText, { reply_markup: supportBtn ? inlineKeyboard([[supportBtn]]) : undefined }).catch(() => {});
}

export function registerImageModerationDecisions(composer: Composer<NavaContext>) {
  composer.callbackQuery(/^modimg:(approve|reject):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const decision = ctx.match![1] === "approve" ? "approved" : "rejected";
    const recordId = ctx.match![2]!;

    let result = await decideModerationRecord(recordId, decision, ctx.from!.id);
    // v1.29.0: «عدم تأیید» on a photo that is already live
    if (result.status !== "decided" && decision === "rejected") {
      const revoked = await revokeAppliedRecord(recordId, ctx.from!.id);
      if (revoked) result = { status: "decided", doc: revoked };
    }
    await ctx.answerCallbackQuery();
    if (result.status !== "decided") return; // already decided — idempotent no-op

    // the card lives in the management channel: show WHO decided and what, and remove the buttons
    const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? String(ctx.from?.id));
    const stamp = `\n\n${decision === "approved" ? "✅ تأیید شد" : result.doc.appliedAtOnce ? "❌ عدم تأیید شد؛ عکس حذف شد" : "❌ رد شد"} — توسط ${who}`;
    const m: any = ctx.callbackQuery?.message;
    if (m && typeof m.caption === "string") await ctx.editMessageCaption({ caption: `${m.caption}${stamp}`.slice(0, 1024), reply_markup: { inline_keyboard: [] } }).catch(() => {});
    else await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

    const { doc } = result;
    // "chat_image" records only exist from before the v1.8.0 upgrade (see
    // features/photo/chatPhotoModeration.ts, which replaced the old
    // approval-gated chat-image flow with instant delivery + a moderation
    // log). Any such legacy pending record is simply inert now.
    if (doc.type === "profile_photo") {
      await handleProfilePhotoDecision(ctx, doc, decision);
    }
  });
}
