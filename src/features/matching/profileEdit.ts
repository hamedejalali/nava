import { enforceAgeBandOnSession } from "../../services/ageChangeCleanup.js";
import { sendRestore } from "../common/keyboardState.js";
import { isAdmin } from "../admin/constants.js";
import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { PROVINCES } from "../../data/provinces.js";
import { citiesForProvince, isValidCityForProvince } from "../../data/cities.js";
import { usersCollectionDirectSet, setUserLocation, getUser } from "../../db/models/user.js";
import { isValidEnglishNickname } from "../onboarding/nickname.js";
import { createEditRequest, decideEditRequest, revokeAppliedEditRequest } from "../../db/models/editRequests.js";
import {  } from "../admin/constants.js";
import { getRecipients } from "../../services/channelRouting.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { showOwnProfile } from "./profile.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";
import { startVerifyRequest } from "./verifyFlow.js";
import { VERIFY_REQUEST_CALLBACK } from "./constants.js";

export const MIN_AGE = 9;
export const MAX_AGE = 99;
export const MAX_BIO_LENGTH = 300;

type AwaitingField = "photo" | "bio" | "province" | "city" | "location" | "nickname_request" | "age_request";

interface EditFlowDoc {
  _id: number;
  awaiting: AwaitingField;
}

async function setAwaiting(adminId: number, awaiting: AwaitingField | null): Promise<void> {
  const db = await getDb();
  const col = db.collection<EditFlowDoc>("profile_edit_flow");
  if (awaiting) {
    await clearAllUserFlows(adminId); // only ONE "waiting for text" step at a time
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
    // Province/city are intentionally NOT editable by the user anymore —
    // removed on request. They're still set once during onboarding and
    // can only be changed by an admin (resetUser / direct DB edit).
    [glassButton("📍 ثبت موقعیت مکانی", EDIT_CALLBACKS.location, "primary")],
    [glassButton("✏️ تغییر نام", EDIT_CALLBACKS.requestNickname, "danger")],
    [glassButton("✏️ درخواست تغییر سن", EDIT_CALLBACKS.requestAge, "danger")],
    // (No verify button here on purpose — "درخواست وریفای" lives ONLY under
    // "ویرایش پروفایل" in the profile message itself.)
    [glassButton("❌ انصراف", EDIT_CALLBACKS.cancel, "danger")],
  ]);
}

export function registerProfileEdit(composer: Composer<NavaContext>) {
  composer.callbackQuery(EDIT_CALLBACKS.open, async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearAllUserFlows(ctx.from!.id); // never leave a half-done step (verify, report...) behind
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
    await ctx.reply(`بیوگرافی جدیدت رو بفرست (حداکثر ${MAX_BIO_LENGTH} کاراکتر):`, { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(EDIT_CALLBACKS.photo, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "photo"); // marks the step as pending so the red cancel keyboard is not swapped back at once
    await ctx.reply("عکس جدید پروفایلت رو همینجا بفرست؛ بلافاصله جایگزین میشه.", { reply_markup: cancelKeyboard() });
  });

  // Province/city editing was removed on request — these two handlers
  // stay registered (harmless) only so an OLD inline keyboard still
  // sitting in someone's chat history from before this change doesn't
  // spin forever with no response when tapped.
  composer.callbackQuery(EDIT_CALLBACKS.province, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "استان دیگه قابل ویرایش نیست.", show_alert: true });
  });

  composer.callbackQuery(EDIT_CALLBACKS.city, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "شهر دیگه قابل ویرایش نیست.", show_alert: true });
  });

  composer.callbackQuery(EDIT_CALLBACKS.location, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "location");
    await ctx.reply("از دکمه‌ی 📎 (ضمیمه) پایین صفحه، گزینه‌ی Location رو بزن و موقعیتت رو بفرست.", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestNickname, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "nickname_request");
    await ctx.reply("نام مستعار جدیدی که می‌خوای رو (فقط حروف انگلیسی) بفرست؛ بلافاصله اعمال میشه.", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestAge, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setAwaiting(ctx.from!.id, "age_request");
    await ctx.reply("سن جدیدی که می‌خوای رو بفرست. این درخواست باید توسط ادمین تایید بشه.", { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(EDIT_CALLBACKS.requestVerify, async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearAllUserFlows(ctx.from!.id);
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
      await sendRestore(ctx, "لغو شد ✅");
      return;
    }

    if (awaiting === "photo") {
      await ctx.reply("الان منتظر عکس پروفایل جدیدتم 🖼 (یا ❌ لغو رو بزن).", { reply_markup: cancelKeyboard() });
      return;
    }

    if (awaiting === "bio") {
      if (raw.length === 0 || raw.length > MAX_BIO_LENGTH) {
        await ctx.reply(`بیوگرافی باید بین ۱ تا ${MAX_BIO_LENGTH} کاراکتر باشه.`, { reply_markup: cancelKeyboard() });
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
        await ctx.reply("این اسم استان معتبر نیست. دقیقاً از لیستی که فرستادم انتخاب کن.", { reply_markup: cancelKeyboard() });
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
        await ctx.reply("این اسم شهر برای استان انتخابی معتبر نیست. دقیقاً از لیستی که فرستادم انتخاب کن.", { reply_markup: cancelKeyboard() });
        return;
      }
      await usersCollectionDirectSet(user._id, { city: raw });
      await setAwaiting(ctx.from!.id, null);
      await ctx.reply("✅ شهر بروزرسانی شد.");
      await showOwnProfile(ctx);
      return;
    }

    if (awaiting === "nickname_request") {
      if (!isValidEnglishNickname(raw)) {
        await ctx.reply("این نام مستعار معتبر نیست (فقط حروف انگلیسی و فاصله، حداکثر ۳۲ کاراکتر).", { reply_markup: cancelKeyboard() });
        return;
      }
      await setAwaiting(ctx.from!.id, null);
      if (raw === (user.nickname ?? "")) {
        await ctx.reply("این همون نام فعلیته 🙂");
        return;
      }
      // v1.29.0: a new name needs nobody's approval; the staff get a copy with one «عدم تأیید» button
      await applyNicknameNow(ctx.api, user, raw);
      await ctx.reply("✅ نامت تغییر کرد.");
      await showOwnProfile(ctx);
      return;
    }

    if (awaiting === "age_request") {
      const age = Number(raw);
      if (!Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) {
        await ctx.reply(`سن باید یک عدد صحیح بین ${MIN_AGE} تا ${MAX_AGE} باشه.`, { reply_markup: cancelKeyboard() });
        return;
      }
      await setAwaiting(ctx.from!.id, null);
      const previousAge = String(user.age ?? "-");
      const request = await createEditRequest(user._id, "age", previousAge, String(age));
      await ctx.reply("✅ درخواستت برای ادمین ارسال شد. بعد از تایید اعمال میشه.");
      await notifyAdminsOfRequest(ctx, request._id, user, "age", previousAge, String(age));
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
  previousValue: string,
  newValue: string
): Promise<void> {
  await notifyRecipientsOfEditRequest(ctx.api, requestId, user, field, previousValue, newValue);
}

/** v1.29.0 — a new nickname is live at once. Records it (status «applied»), then sends the staff a copy with a single
 *  «عدم تأیید نام» button (no approve button). Shared by the bot and the Mini App. */
export async function applyNicknameNow(
  api: { sendMessage: (chatId: number, text: string, other?: any) => Promise<unknown> },
  user: { _id: number; anonId: string; nickname?: string },
  value: string,
  recipients?: number[],
): Promise<void> {
  const previous = user.nickname ?? "-";
  await usersCollectionDirectSet(user._id, { nickname: value });
  const request = await createEditRequest(user._id, "nickname", previous, value, "applied");
  await notifyRecipientsOfEditRequest(api, request._id, user, "nickname", previous, value, recipients, "applied");
}

/** Same notification the bot sends, usable without a grammY context (the Mini App uses it).
 *  mode "pending" (age): ✅ / ❌ buttons, the change waits. mode "applied" (name): already live, ONE «عدم تأیید» button. */
export async function notifyRecipientsOfEditRequest(
  api: { sendMessage: (chatId: number, text: string, other?: any) => Promise<unknown> },
  requestId: string,
  user: { _id: number; anonId: string },
  field: "nickname" | "age",
  previousValue: string,
  newValue: string,
  recipients?: number[],
  mode: "pending" | "applied" = "pending",
): Promise<void> {
  const fieldFa = field === "nickname" ? "نام مستعار" : "سن";
  const text =
    (mode === "applied" ? `📝 تغییر ${fieldFa} (فوراً اعمال شد)\n\n` : `📝 درخواست تغییر ${fieldFa}\n\n`) +
    `کاربر: ${user.anonId} (${user._id})\n` +
    `مقدار قبلی: ${previousValue}\n` +
    `مقدار جدید: ${newValue}`;
  const kb =
    mode === "applied"
      ? inlineKeyboard([[glassButton("❌ عدم تأیید نام", `${ADMIN_DECISION_PREFIX.reject}${requestId}`, "danger")]])
      : inlineKeyboard([
          [
            glassButton("✅ تایید", `${ADMIN_DECISION_PREFIX.approve}${requestId}`, "success"),
            glassButton("❌ رد", `${ADMIN_DECISION_PREFIX.reject}${requestId}`, "danger"),
          ],
        ]);
  for (const adminId of recipients ?? (await getRecipients("profileEdit"))) {
    await api.sendMessage(adminId, text, { reply_markup: kb }).catch(() => {});
  }
}

async function handleAdminDecision(ctx: NavaContext, requestId: string, decision: "approved" | "rejected"): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery();
  let request = await decideEditRequest(requestId, decision, ctx.from!.id);
  // v1.29.0: «عدم تأیید نام» on a name that is already live → give the old name back and tell the person
  let revoked = false;
  if (!request && decision === "rejected") {
    request = await revokeAppliedEditRequest(requestId, ctx.from!.id);
    revoked = !!request;
  }
  if (!request) {
    await ctx.editMessageText("این درخواست قبلاً بررسی شده.").catch(() => {});
    return;
  }
  const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? String(ctx.from?.id));

  if (revoked) {
    const current = await getUser(request.telegramId);
    const canRestore = request.field === "nickname" && request.oldValue !== "-" && current?.nickname === request.newValue;
    if (canRestore) await usersCollectionDirectSet(request.telegramId, { nickname: request.oldValue });
    await ctx.api
      .sendMessage(request.telegramId, canRestore ? `⚠️ به دلیل عدم رعایت قوانین، نام شما به «${request.oldValue}» برگردانده شد.` : "⚠️ به دلیل عدم رعایت قوانین، تغییر نام شما تأیید نشد.")
      .catch(() => {});
    await ctx.editMessageText(`📝 تغییر نام — ❌ عدم تأیید شد${canRestore ? `؛ نام به «${request.oldValue}» برگشت` : ""}\nتوسط ${who}`).catch(() => {});
    return;
  }

  if (decision === "approved") {
    if (request.field === "nickname") {
      await usersCollectionDirectSet(request.telegramId, { nickname: request.newValue });
    } else {
      await usersCollectionDirectSet(request.telegramId, { age: Number(request.newValue) });
      // v1.29.8 (A-03): an approved age change may put the person in the other age band → end a running chat that is no longer allowed
      const moved = await getUser(request.telegramId).catch(() => null);
      if (moved?.activeChatSessionId) await enforceAgeBandOnSession(ctx.api, moved.activeChatSessionId, request.telegramId);
    }
    await ctx.api.sendMessage(request.telegramId, "✅ درخواست تغییر پروفایلت توسط ادمین تایید و اعمال شد.").catch(() => {});
  } else {
    await ctx.api.sendMessage(request.telegramId, "❌ درخواست تغییر پروفایلت توسط ادمین رد شد.").catch(() => {});
  }

  const fieldFa = request.field === "nickname" ? "نام مستعار" : "سن";
  const decisionFa = decision === "approved" ? "✅ تایید شد" : "❌ رد شد";
  await ctx.editMessageText(`📝 درخواست تغییر ${fieldFa} — ${decisionFa}\nتوسط ${who}`).catch(() => {});
}
