import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
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
  `• ${textEmoji("VERIFIED_BADGE", "🔵")} تیک آبی وریفای در کنار پروفایل شما نمایش داده می‌شود.\n` +
  "• 🎯 شانس بیشتری برای متصل شدن به سایر کاربران خواهید داشت.\n" +
  "• 🚀 در فرایند مچینگ، اولویت بیشتری نسبت به کاربران عادی خواهید داشت.\n" +
  "• ⭐ پروفایل شما به‌عنوان یک کاربر وریفای‌شده و معتبر نمایش داده می‌شود.\n\n" +
  "☑️ با ادامه فرایند و ارسال اطلاعات، تأیید می‌کنید که قوانین فوق را مطالعه کرده‌اید و با ذخیره و پردازش اطلاعات ارسالی برای انجام وریفای موافق هستید.";

interface VerifyFlowDoc {
  _id: number;
  stage: "await_photo" | "await_phone";
  photoFileId?: string;
}

async function setFlow(userId: number, flow: VerifyFlowDoc | null): Promise<void> {
  const db = await getDb();
  const col = db.collection<VerifyFlowDoc>("verify_flow");
  if (!flow) await col.deleteOne({ _id: userId });
  else await col.replaceOne({ _id: userId }, flow, { upsert: true });
}
async function getFlow(userId: number): Promise<VerifyFlowDoc | null> {
  const db = await getDb();
  return db.collection<VerifyFlowDoc>("verify_flow").findOne({ _id: userId });
}

const CB = {
  agree: "verify:agree",
  cancel: "verify:cancel",
  approve: "admin:verify:approve:", // + userId
  reject: "admin:verify:reject:", // + userId
};

export async function startVerifyRequest(ctx: NavaContext): Promise<void> {
  const photos = env.VERIFY_PHOTOS;
  const kb = inlineKeyboard([
    [
      glassButton("✅ موافقم", CB.agree, "success"),
      glassButton("❌ کنسل", CB.cancel, "danger"),
    ],
  ]);

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

export function registerVerifyFlow(composer: Composer<NavaContext>) {
  composer.callbackQuery(CB.cancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setFlow(ctx.from!.id, null);
    await ctx.deleteMessage().catch(() => {});
  });

  composer.callbackQuery(CB.agree, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_photo" });
    await ctx.reply(
      "یکی از عکس‌های نمونه رو که دیدی، دقیقاً همون‌طوری از خودت با انگشتت کنار صورتت بگیر و همینجا بفرست."
    );
  });

  composer.on("message:photo", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_photo") return next();

    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1]!;
    await setFlow(ctx.from!.id, { _id: ctx.from!.id, stage: "await_phone", photoFileId: largest.file_id });
    await ctx.reply(
      "شماره تلفن همین اکانت تلگرام رو بفرست (با دکمه‌ی 📎 گزینه‌ی Contact رو بزن، یا خودت تایپ کن)."
    );
  });

  composer.on("message:contact", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_phone") return next();
    await finalizeVerify(ctx, flow, ctx.message.contact.phone_number);
  });

  composer.on("message:text", async (ctx, next) => {
    const flow = await getFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_phone") return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (!/^\+?\d{8,15}$/.test(text)) {
      await ctx.reply("شماره معتبر نیست. دوباره بفرست (مثلاً 09121234567).");
      return;
    }
    await finalizeVerify(ctx, flow, text);
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
  await ctx.reply("✅ اطلاعات شما بررسی و به شما اطلاع داده می‌شود.");

  const user = ctx.dbUser;
  const caption =
    `🔵 درخواست وریفای جدید\n\n` +
    `کاربر: @${user?.anonId ?? "-"}\n` +
    `آیدی عددی: <code>${ctx.from!.id}</code>\n` +
    `شماره تلفن ارسالی: <code>${phone}</code>`;

  const kb = inlineKeyboard([
    [
      glassButton("✅ تایید", `${CB.approve}${ctx.from!.id}`, "success"),
      glassButton("❌ رد", `${CB.reject}${ctx.from!.id}`, "danger"),
    ],
  ]);

  for (const adminId of await getAllAdminIds()) {
    await ctx.api.sendPhoto(adminId, flow.photoFileId!, { caption, parse_mode: "HTML", reply_markup: kb }).catch(() => {});
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
