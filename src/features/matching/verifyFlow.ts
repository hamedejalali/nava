import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard, contactReplyButton, glassReplyButton, replyKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { buildMainMenuReplyKeyboard } from "../menu/mainMenu.js";
import { env } from "../../config/env.js";
import { textEmoji } from "../../config/emojis.js";
import { getUser, setVerified } from "../../db/models/user.js";
import { getAllAdminIds, isOwner } from "../admin/constants.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { getContent } from "../../db/models/content.js";
import { escapeHtml } from "../../utils/html.js";
import { notifyVerificationChange, sendPhotoOrText } from "../admin/verifyNotify.js";

const VERIFY_TERMS_TEXT =
  "⚠️ قوانین و شرایط وریفای\n\n" +
  "قبل از شروع فرایند وریفای، لطفاً موارد زیر را با دقت مطالعه کنید:\n\n" +
  "📌 شرایط و اطلاعات وریفای\n\n" +
  "• برای انجام وریفای، عکس و شماره تلفن شما دریافت و در دیتابیس سامانه ذخیره می‌شود.\n\n" +
  "• با ارسال عکس و شماره تلفن، شما با ذخیره و پردازش این اطلاعات جهت انجام فرایند وریفای موافقت می‌کنید.\n\n" +
  "• شماره تلفن واردشده باید متعلق به همین اکانت تلگرام باشد که در حال انجام وریفای است.\n\n" +
  "• استفاده از شماره تلفن جعلی، متعلق به شخص دیگر یا شماره‌ای غیر از شماره همین اکانت، موجب مسدود شدن شما از ربات خواهد شد.\n\n" +
  "• از ارسال عکس افراد دیگر، تصاویر جعلی یا تصاویری که اجازه استفاده از آن‌ها را ندارید خودداری کنید.\n\n" +
  "• مسئولیت صحت، قانونی بودن و محتوای اطلاعات و عکس ارسال‌شده کاملاً بر عهده خود کاربر است.\n\n" +
  "• در صورت ارسال اطلاعات یا تصویر نادرست، جعل هویت، سوءاستفاده از سیستم یا هرگونه تخلف، مسئولیت عواقب آن بر عهده کاربر خواهد بود.\n\n" +
  "✅ مزایای وریفای\n\n" +
  "در صورت تأیید پروفایل شما:\n\n" +
  `• ${textEmoji("VERIFIED_BADGE", "✅")} تیک سبز وریفای در کنار اسم شما در پروفایل نمایش داده می‌شود.\n` +
  "• 🎯 شانس بیشتری برای متصل شدن به سایر کاربران خواهید داشت.\n" +
  "• 🚀 در فرایند مچینگ، اولویت بیشتری نسبت به کاربران عادی خواهید داشت.\n" +
  "• ⭐ پروفایل شما به‌عنوان یک کاربر وریفای‌شده و معتبر نمایش داده می‌شود.\n\n" +
  "☑️ با ادامه فرایند و ارسال اطلاعات، تأیید می‌کنید که قوانین فوق را مطالعه کرده‌اید و با ذخیره و پردازش اطلاعات ارسالی برای انجام وریفای موافق هستید.";

interface VerifyFlowDoc {
  _id: number;
  stage: "await_agree" | "await_photo" | "await_phone";
  photoFileId?: string;
  updatedAt?: number;
}

/** A verify request that sits untouched for this long is forgotten, so an
 *  abandoned request can never block later photos (e.g. a new profile photo). */
const FLOW_TTL_MS = 30 * 60 * 1000;

async function setFlow(userId: number, flow: VerifyFlowDoc | null): Promise<void> {
  const db = await getDb();
  const col = db.collection<VerifyFlowDoc>("verify_flow");
  if (!flow) await col.deleteOne({ _id: userId });
  else await col.replaceOne({ _id: userId }, { ...flow, updatedAt: Date.now() }, { upsert: true });
}
async function getFlow(userId: number): Promise<VerifyFlowDoc | null> {
  const db = await getDb();
  const col = db.collection<VerifyFlowDoc>("verify_flow");
  const doc = await col.findOne({ _id: userId });
  if (doc && doc.updatedAt && Date.now() - doc.updatedAt > FLOW_TTL_MS) {
    await col.deleteOne({ _id: userId });
    return null;
  }
  return doc;
}

const CB = {
  agree: "verify:agree",
  cancel: "verify:cancel",
  approve: "admin:verify:approve:", // + userId
  reject: "admin:verify:reject:", // + userId
};

const CONTACT_BUTTON_LABEL = "📱 اشتراک‌گذاری شماره تلفن";
const CANCEL_TEXT_LABEL = "❌ لغو";

export async function startVerifyRequest(ctx: NavaContext): Promise<void> {
  // Two states only: verified, or not verified. A verified user has
  // nothing to request.
  if (ctx.dbUser?.verified) {
    await ctx.reply("✅ شما قبلاً وریفای شدید و نیازی به درخواست دوباره نیست.");
    return;
  }

  const photos = env.VERIFY_PHOTOS;
  const kb = inlineKeyboard([
    [
      glassButton("✅ موافقم", CB.agree, "success"),
      glassButton("❌ کنسل", CB.cancel, "danger"),
    ],
  ]);

  // Nothing (photo/phone) is accepted until the user taps «موافقم».
  await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_agree" });

  // The terms text is ~1300 chars, but Telegram caps a PHOTO caption at
  // 1024 — sending it as a caption made this whole screen fail whenever a
  // sample photo was configured. So: sample photo first, then the terms as
  // a normal message carrying the buttons.
  if (photos.length > 0) {
    const chosen = photos[Math.floor(Math.random() * photos.length)]!;
    await ctx.replyWithPhoto(chosen).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[verify] sample photo could not be sent (wrong file_id for this bot?):", err);
    });
  }
  await ctx.reply(VERIFY_TERMS_TEXT, { reply_markup: kb });
}

/** Restores the normal main-menu keyboard after the share-contact keyboard. */
function mainMenuMarkup(ctx: NavaContext) {
  return buildMainMenuReplyKeyboard(ctx.userLang);
}

export function registerVerifyFlow(composer: Composer<NavaContext>) {
  composer.callbackQuery(CB.cancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setFlow(ctx.from!.id, null);
    await ctx.deleteMessage().catch(() => {});
  });

  // Step 1 — «موافقم»: only NOW does the bot start accepting the photo.
  composer.callbackQuery(CB.agree, async (ctx) => {
    if (ctx.dbUser?.verified) {
      await ctx.answerCallbackQuery({ text: "شما قبلاً وریفای شدید ✅", show_alert: true });
      return;
    }
    const flow = await getFlow(ctx.from!.id);
    if (!flow) {
      await ctx.answerCallbackQuery({ text: "این درخواست منقضی شده. از پروفایلت دوباره «درخواست وریفای» رو بزن.", show_alert: true });
      return;
    }
    if (flow.stage !== "await_agree") {
      await ctx.answerCallbackQuery(); // double tap
      return;
    }
    await ctx.answerCallbackQuery();
    await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_photo" });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.reply(
      "📸 مرحله‌ی ۱ از ۲\n\nیکی از عکس‌های نمونه رو که دیدی، دقیقاً همون‌طوری از خودت با انگشتت کنار صورتت بگیر و همینجا بفرست.",
      { reply_markup: cancelKeyboard() }
    );
  });

  // Step 2 — the photo. Registered with a flow check so the generic
  // profile-photo uploader (src/features/photo/moderation.ts) never
  // swallows a verification selfie.
  composer.on("message:photo", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow) return next();

    if (flow.stage === "await_agree") {
      await ctx.reply("اول قوانین بالا رو بخون و روی «✅ موافقم» بزن، بعد عکست رو بفرست.");
      return;
    }
    if (flow.stage === "await_phone") {
      await ctx.reply("عکست قبلاً دریافت شد ✅ حالا فقط شماره‌ت رو با دکمه‌ی «" + CONTACT_BUTTON_LABEL + "» پایین بفرست.");
      return;
    }

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_phone", photoFileId: largest.file_id });
    await ctx.reply(
      "✅ عکست دریافت شد.\n\n📱 مرحله‌ی ۲ از ۲\n\nشماره‌ی همین اکانت تلگرامت رو با دکمه‌ی «" + CONTACT_BUTTON_LABEL + "» پایین صفحه بفرست.",
      {
        reply_markup: replyKeyboard(
          [[contactReplyButton(CONTACT_BUTTON_LABEL, "success")], [glassReplyButton(CANCEL_TEXT_LABEL, "danger")]]
        ),
      }
    );
  });

  // Step 3 — the phone number, ONLY through the native share-contact button,
  // and only if it belongs to this same Telegram account.
  composer.on("message:contact", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow) return next();

    if (flow.stage !== "await_phone") {
      await ctx.reply(
        flow.stage === "await_agree"
          ? "اول قوانین رو بخون و روی «✅ موافقم» بزن."
          : "اول عکست رو بفرست، بعد شماره‌ت رو.",
        { reply_markup: mainMenuMarkup(ctx) }
      );
      return;
    }

    const contact = ctx.message.contact;
    if (contact.user_id !== ctx.from!.id) {
      await ctx.reply("این شماره متعلق به اکانت خودت نیست ❌ فقط شماره‌ی همین اکانت رو با دکمه‌ی «" + CONTACT_BUTTON_LABEL + "» بفرست.");
      return;
    }
    await finalizeVerify(ctx, flow, contact.phone_number);
  });

  composer.on("message:text", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage === "await_photo") {
      // (await_photo text is handled by the generic red «لغو» button; any
      //  other text just falls through as usual)
      return next();
    }

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.", { reply_markup: mainMenuMarkup(ctx) });
      return;
    }
    if (flow.stage === "await_phone") {
      await ctx.reply("شماره رو فقط با دکمه‌ی «" + CONTACT_BUTTON_LABEL + "» بفرست (تایپ کردن قبول نیست).");
      return;
    }
    // await_agree: ignore other text
    return next();
  });

  composer.callbackQuery(new RegExp(`^${CB.approve}(\\d+)$`), async (ctx) => decide(ctx, Number(ctx.match![1]), "approved"));
  composer.callbackQuery(new RegExp(`^${CB.reject}(\\d+)$`), async (ctx) => decide(ctx, Number(ctx.match![1]), "rejected"));

  // Owner's free-text reason for a rejection, captured right after tapping
  // "❌ رد" above.
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const db = await getDb();
    const col = db.collection<{ _id: number; stage: string; targetId: number }>("verify_reject_flow");
    const flow = await col.findOne({ _id: ctx.from!.id });
    if (!flow || flow.stage !== "await_reason") return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await col.deleteOne({ _id: ctx.from!.id });
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد (وریفای همچنان به حالت رد‌شده باقی می‌مونه، فقط دلیلی ارسال نشد).");
      return;
    }

    await col.deleteOne({ _id: ctx.from!.id });
    const supportId = await getContent("supportId", "");
    const supportLine = supportId ? `\n\nاگر اعتراض داری، به آیدی پشتیبانی پیام بده: ${escapeHtml(supportId)}` : "";
    const rejectionHtml = `❌ درخواست وریفای شما رد شد.\n\nدلیل: ${escapeHtml(text)}${supportLine}`;
    await sendPhotoOrText(ctx.api, flow.targetId, env.VERIFY_REJECTED_PHOTO, rejectionHtml);
    await ctx.reply("✅ دلیل رد برای کاربر ارسال شد.");
  });
}

async function finalizeVerify(ctx: NavaContext, flow: VerifyFlowDoc, phone: string) {
  await setFlow(ctx.from!.id, null);
  await ctx.reply("✅ عکس و شماره‌ت برای ادمین ارسال شد. بعد از بررسی نتیجه بهت اطلاع داده میشه.", {
    reply_markup: mainMenuMarkup(ctx),
  });

  const user = ctx.dbUser;
  const caption =
    `${textEmoji("VERIFY_REQUEST", "✅")} درخواست وریفای جدید\n\n` +
    `کاربر: <code>${escapeHtml(user?.anonId ?? "-")}</code>\n` +
    `نام: ${escapeHtml(user?.nickname ?? "-")}\n` +
    `آیدی عددی: <code>${ctx.from!.id}</code>\n` +
    `شماره تلفن (تایید‌شده توسط تلگرام): <code>${escapeHtml(phone)}</code>`;

  const kb = inlineKeyboard([
    [
      glassButton("✅ تایید", `${CB.approve}${ctx.from!.id}`, "success"),
      glassButton("❌ رد", `${CB.reject}${ctx.from!.id}`, "danger"),
    ],
  ]);

  // Photo + phone travel together (the phone is in the photo's caption).
  for (const adminId of await getAllAdminIds()) {
    await ctx.api.sendPhoto(adminId, flow.photoFileId!, { caption, parse_mode: "HTML", reply_markup: kb }).catch(async () => {
      await ctx.api.sendMessage(adminId, caption, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    });
  }
}

async function decide(ctx: NavaContext, userId: number, decision: "approved" | "rejected") {
  if (!isOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: "فقط مالک ربات می‌تونه وریفای رو تایید/رد کنه." });
    return;
  }
  await ctx.answerCallbackQuery();

  if (decision === "approved") {
    await setVerified(userId, true);
    await notifyVerificationChange(ctx.api, userId, true);
    await ctx.editMessageCaption({ caption: "✅ وریفای تایید شد." }).catch(() => {});
  } else {
    await setVerified(userId, false);
    await ctx.reply("دلیل رد وریفای رو بنویس (برای کاربر ارسال میشه):");
    const db = await getDb();
    await db
      .collection<{ _id: number; stage: string; targetId: number }>("verify_reject_flow")
      .updateOne({ _id: ctx.from!.id }, { $set: { stage: "await_reason", targetId: userId } }, { upsert: true });
    await ctx.editMessageCaption({ caption: "❌ وریفای رد شد — منتظر دلیل رد..." }).catch(() => {});
  }
}
