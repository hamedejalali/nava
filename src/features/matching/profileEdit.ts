import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { PROVINCES } from "../../data/provinces.js";
import { citiesForProvince, isValidCityForProvince } from "../../data/cities.js";
import { usersCollectionDirectSet, setUserLocation } from "../../db/models/user.js";
import { isValidPersianNickname } from "../onboarding/nickname.js";
import { createEditRequest, decideEditRequest, getEditRequest } from "../../db/models/editRequests.js";
import { getAllAdminIds } from "../admin/constants.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { showOwnProfile } from "./profile.js";
import { buttonIcon } from "../../config/emojis.js";
import { startVerifyRequest } from "./verifyFlow.js";
import { VERIFY_REQUEST_CALLBACK } from "./constants.js";

const MIN_AGE = 9;
const MAX_AGE = 99;
const MAX_BIO_LENGTH = 300;

type AwaitingField = "bio" | "province" | "city" | "location" | "nickname_request" | "age_request";

interface EditFlowDoc {
  _id: number;
  awaiting: AwaitingField;
}

async function setAwaiting(adminId: number, awaiting: AwaitingField | null): Promise<void> {
  const db = await getDb();
  const col = db.collection<EditFlowDoc>("profile_edit_flow");
  if (awaiting) {
    await col.updateOne({ _id: adminId }, { $set: { awaiting } }, { upsert: true });
  } else {
    await col.deleteOne({ _id: adminId });
  }
}
async function getAwaiting(telegramId: number): Promise<AwaitingField | null> {
  const db = await getDb();
  const doc = await db.collection<EditFlowDoc>("profile_edit_flow").findOne({ _id: telegramId });
  return doc?.awaiting ?? null;
}

const EDIT_CALLBACKS = {
  open: "profile:edit",
  bio: "profile:edit:bio",
  photo: "profile:edit:photo",
  province: "profile:edit:province",
  city: "profile:edit:city",
  location: "profile:edit:location",
  requestNickname: "profile:edit:req_nickname",
  requestAge: "profile:edit:req_age",
  requestVerify: VERIFY_REQUEST_CALLBACK,
  cancel: "profile:edit:cancel",
};

const ADMIN_DECISION_PREFIX = {
  approve: "admin:editreq:approve:", // + requestId
  reject: "admin:editreq:reject:", // + requestId
};

function editMenuKeyboard() {
  return inlineKeyboard([
    [glassButton("📝 بیوگرافی", EDIT_CALLBACKS.bio, "primary")],
    [glassButton("🖼 عکس پروفایل", EDIT_CALLBACKS.photo, "primary")],
    [
      glassButton("🏙 استان", EDIT_CALLBACKS.province, "primary"),
      glassButton("🏘 شهر", EDIT_CALLBACKS.city, "primary"),
    ],
    [glassButton("📍 ثبت موقعیت مکانی", EDIT_CALLBACKS.location, "primary")],
    [glassButton("✏️ درخواست تغییر نام", EDIT_CALLBACKS.requestNickname, "danger")],
    [glassButton("✏️ درخواست تغییر سن", EDIT_CALLBACKS.requestAge, "danger")],
    // Emoji on a BUTTON must go through the icon field (never a <tg-emoji>
    // tag in the label — that was the raw-HTML-on-button bug).
    [glassButton("درخواست وریفای", EDIT_CALLBACKS.requestVerify, "primary", buttonIcon("VERIFY_REQUEST"))],
    [glassButton("❌ انصراف", EDIT_CALLBACKS.cancel, "danger")],
  ]);
}

export function registerProfileEdit(composer: Composer<NavaContext>) {
  composer.callbackQuery(EDIT_CALLBACKS.open, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, null);
    await ctx.reply("چه چیزی رو می‌خوای ویرایش کنی؟", { reply_markup: editMenuKeyboard() });
  });

  composer.callbackQuery(EDIT_CALLBACKS.cancel, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, null);
    await ctx.deleteMessage().catch(() => {});
  });

  composer.callbackQuery(EDIT_CALLBACKS.bio, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "bio");
    await ctx.reply(`بیوگرافی جدیدت رو بفرست (حداکثر ${MAX_BIO_LENGTH} کاراکتر):`);
  });

  composer.callbackQuery(EDIT_CALLBACKS.photo, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, null);
    await ctx.reply("عکس جدید پروفایلت رو همینجا بفرست، بعد از تایید ادمین جایگزین میشه.");
  });

  composer.callbackQuery(EDIT_CALLBACKS.province, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "province");
    const names = PROVINCES.map((p) => p.nameFa).join("، ");
    await ctx.reply(`اسم استان جدیدت رو دقیقاً بفرست.\n\nاستان‌های معتبر:\n${names}`);
  });

  composer.callbackQuery(EDIT_CALLBACKS.city, async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = ctx.dbUser;
    if (!user?.province) {
      await ctx.reply("اول باید استانت رو ثبت کنی.");
      return;
    }
    await setAwaiting(ctx.from!.id, "city");
    const cities = citiesForProvince(user.province)
      .map((c) => c.nameFa)
      .join("، ");
    await ctx.reply(`اسم شهر جدیدت (داخل استان ${user.province}) رو دقیقاً بفرست.\n\nشهرهای معتبر:\n${cities}`);
  });

  composer.callbackQuery(EDIT_CALLBACKS.location, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "location");
    await ctx.reply("از دکمه‌ی 📎 (ضمیمه) پایین صفحه، گزینه‌ی Location رو بزن و موقعیتت رو بفرست.");
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestNickname, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "nickname_request");
    await ctx.reply("نام مستعار جدیدی که می‌خوای رو بفرست. این درخواست باید توسط ادمین تایید بشه.");
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestAge, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "age_request");
    await ctx.reply("سن جدیدی که می‌خوای رو بفرست. این درخواست باید توسط ادمین تایید بشه.");
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestVerify, async (ctx) => {
    await ctx.answerCallbackQuery();
    await startVerifyRequest(ctx);
  });

  // ---- Text input for whichever field is currently awaited ----
  composer.on("message:text", async (ctx, next) => {
    const awaiting = await getAwaiting(ctx.from!.id);
    if (!awaiting) return next();
    const user = ctx.dbUser;
    if (!user) return next();

    const raw = ctx.message.text.trim();

    if (isFlowCancelSignal(raw)) {
      await setAwaiting(ctx.from!.id, null);
      if (raw.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    if (awaiting === "bio") {
      if (raw.length === 0 || raw.length > MAX_BIO_LENGTH) {
        await ctx.reply(`بیوگرافی باید بین ۱ تا ${MAX_BIO_LENGTH} کاراکتر باشه.`);
        return;
      }
      await usersCollectionDirectSet(user._id, { bio: raw });
      await setAwaiting(ctx.from!.id, null);
      await ctx.reply("✅ بیوگرافی بروزرسانی شد.");
      await showOwnProfile(ctx);
      return;
    }

    if (awaiting === "province") {
      const match = PROVINCES.find((p) => p.nameFa === raw);
      if (!match) {
        await ctx.reply("این اسم استان معتبر نیست. دقیقاً از لیستی که فرستادم انتخاب کن.");
        return;
      }
      // Changing province invalidates the previously-picked city.
      await usersCollectionDirectSet(user._id, { province: match.nameFa, city: undefined });
      await setAwaiting(ctx.from!.id, null);
      await ctx.reply("✅ استان بروزرسانی شد. حالا شهرت رو هم دوباره ثبت کن.");
      return;
    }

    if (awaiting === "city") {
      if (!user.province) {
        await setAwaiting(ctx.from!.id, null);
        await ctx.reply("اول باید استانت رو ثبت کنی.");
        return;
      }
      if (!isValidCityForProvince(raw, user.province)) {
        await ctx.reply("این اسم شهر برای استان انتخابی معتبر نیست. دقیقاً از لیستی که فرستادم انتخاب کن.");
        return;
      }
      await usersCollectionDirectSet(user._id, { city: raw });
      await setAwaiting(ctx.from!.id, null);
      await ctx.reply("✅ شهر بروزرسانی شد.");
      await showOwnProfile(ctx);
      return;
    }

    if (awaiting === "nickname_request") {
      if (!isValidPersianNickname(raw)) {
        await ctx.reply("این نام مستعار معتبر نیست (فقط حروف فارسی، حداکثر ۳۲ کاراکتر).");
        return;
      }
      await setAwaiting(ctx.from!.id, null);
      const request = await createEditRequest(user._id, "nickname", user.nickname ?? "-", raw);
      await ctx.reply("✅ درخواستت برای ادمین ارسال شد. بعد از تایید اعمال میشه.");
      await notifyAdminsOfRequest(ctx, request._id, user, "nickname", raw);
      return;
    }

    if (awaiting === "age_request") {
      const age = Number(raw);
      if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) {
        await ctx.reply(`سن باید یک عدد صحیح بین ${MIN_AGE} تا ${MAX_AGE} باشه.`);
        return;
      }
      await setAwaiting(ctx.from!.id, null);
      const request = await createEditRequest(user._id, "age", String(user.age ?? "-"), String(age));
      await ctx.reply("✅ درخواستت برای ادمین ارسال شد. بعد از تایید اعمال میشه.");
      await notifyAdminsOfRequest(ctx, request._id, user, "age", String(age));
      return;
    }
  });

  // ---- Location input ----
  composer.on("message:location", async (ctx, next) => {
    const awaiting = await getAwaiting(ctx.from!.id);
    if (awaiting !== "location") return next();

    const { latitude, longitude } = ctx.message.location;
    await setUserLocation(ctx.from!.id, latitude, longitude);
    await setAwaiting(ctx.from!.id, null);
    await ctx.reply("✅ موقعیت مکانی ثبت شد. حالا فاصله‌ت با کاربرانی که اونام موقعیتشون رو ثبت کردن نشون داده میشه.");
  });

  // ---- Admin approve/reject buttons ----
  composer.callbackQuery(new RegExp(`^${ADMIN_DECISION_PREFIX.approve}(.+)$`), async (ctx) => {
    await handleAdminDecision(ctx, ctx.match![1]!, "approved");
  });
  composer.callbackQuery(new RegExp(`^${ADMIN_DECISION_PREFIX.reject}(.+)$`), async (ctx) => {
    await handleAdminDecision(ctx, ctx.match![1]!, "rejected");
  });
}

async function notifyAdminsOfRequest(
  ctx: NavaContext,
  requestId: string,
  user: { _id: number; anonId: string },
  field: "nickname" | "age",
  newValue: string
): Promise<void> {
  const fieldFa = field === "nickname" ? "نام مستعار" : "سن";
  const text =
    `📝 درخواست تغییر ${fieldFa}\n\n` +
    `کاربر: @${user.anonId} (${user._id})\n` +
    `مقدار جدید: ${newValue}`;
  const kb = inlineKeyboard([
    [
      glassButton("✅ تایید", `${ADMIN_DECISION_PREFIX.approve}${requestId}`, "success"),
      glassButton("❌ رد", `${ADMIN_DECISION_PREFIX.reject}${requestId}`, "danger"),
    ],
  ]);
  for (const adminId of await getAllAdminIds()) {
    await ctx.api.sendMessage(adminId, text, { reply_markup: kb }).catch(() => {});
  }
}

async function handleAdminDecision(ctx: NavaContext, requestId: string, decision: "approved" | "rejected"): Promise<void> {
  await ctx.answerCallbackQuery();
  const request = await decideEditRequest(requestId, decision, ctx.from!.id);
  if (!request) {
    await ctx.editMessageText("این درخواست قبلاً بررسی شده.").catch(() => {});
    return;
  }

  if (decision === "approved") {
    if (request.field === "nickname") {
      await usersCollectionDirectSet(request.telegramId, { nickname: request.newValue });
    } else {
      await usersCollectionDirectSet(request.telegramId, { age: Number(request.newValue) });
    }
    await ctx.api.sendMessage(request.telegramId, "✅ درخواست تغییر پروفایلت توسط ادمین تایید و اعمال شد.").catch(() => {});
  } else {
    await ctx.api.sendMessage(request.telegramId, "❌ درخواست تغییر پروفایلت توسط ادمین رد شد.").catch(() => {});
  }

  const fieldFa = request.field === "nickname" ? "نام مستعار" : "سن";
  const decisionFa = decision === "approved" ? "✅ تایید شد" : "❌ رد شد";
  await ctx.editMessageText(`📝 درخواست تغییر ${fieldFa} — ${decisionFa}`).catch(() => {});
}
