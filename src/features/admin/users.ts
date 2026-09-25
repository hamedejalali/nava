import { cancelKeyboard } from "../common/userFlows.js";
import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { searchUsers, listUsersPage, setBanned, setVerified, getUser, type UserDoc } from "../../db/models/user.js";
import { getRelicBalance } from "../../db/models/relic.js";
import { levelDisplay } from "../../config/levels.js";
import { isAdmin } from "./constants.js";
import { setAdminFlow, getAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { isFlowCancelSignal } from "./flowState.js";
import { notifyVerificationChange } from "./verifyNotify.js";

const GENDER_LABEL: Record<string, string> = { male: "پسر", female: "دختر" };

function formatFullProfile(u: UserDoc, balance: number): string {
  return [
    `👤 پروفایل کامل کاربر`,
    ``,
    `آیدی تلگرام: ${u.telegramId}`,
    `آیدی ناشناس: ${u.anonId}`,
    u.username ? `یوزرنیم: @${u.username}` : `یوزرنیم: ندارد`,
    `نیک‌نیم: ${u.nickname ?? "-"}`,
    `نام تلگرام: ${u.firstName}`,
    `سن: ${u.age ?? "-"}`,
    `جنسیت: ${u.gender ? (GENDER_LABEL[u.gender] ?? u.gender) : "-"}`,
    `استان: ${u.province ?? "-"}`,
    `شهر: ${u.city ?? "-"}`,
    `سطح: ${levelDisplay(u.level)}`,
    `وریفای: ${u.verified ? "✅" : "❌"}`,
    `بن: ${u.banned ? `🚫 (${u.banReason ?? "بدون دلیل"})` : "❌"}`,
    `ادمین: ${u.isAdmin ? "✅" : "❌"}`,
    `موجودی رلیک: ${balance}`,
    `مرحله‌ی onboarding: ${u.onboardingStep}`,
  ].join("\n");
}

function profileActionsKeyboard(targetId: number) {
  return inlineKeyboard([
    [
      glassButton("🚫 بن", `admin:user:ban:${targetId}`, "danger"),
      glassButton("🔓 آن‌بن", `admin:user:unban:${targetId}`, "success"),
    ],
    [glassButton("☑️ وریفای/لغو وریفای", `admin:user:toggleverify:${targetId}`, "primary")],
  ]);
}

async function showFullProfile(ctx: NavaContext, target: UserDoc) {
  const balance = await getRelicBalance(target._id);
  await ctx.reply(formatFullProfile(target, balance), { reply_markup: profileActionsKeyboard(target._id) });
}

export function registerAdminUsers(composer: Composer<NavaContext>) {
  composer.callbackQuery(/^admin:user:ban:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match![1]);
    await setBanned(targetId, true, "توسط ادمین");
    await logAdminAction(ctx.from!.id, "ban_user", String(targetId));
    await ctx.answerCallbackQuery({ text: "کاربر بن شد." });
    await ctx.api.sendMessage(targetId, "🚫 دسترسی شما به ربات توسط ادمین مسدود شد.").catch(() => {});
  });

  composer.callbackQuery(/^admin:user:unban:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match![1]);
    await setBanned(targetId, false);
    await logAdminAction(ctx.from!.id, "unban_user", String(targetId));
    await ctx.answerCallbackQuery({ text: "کاربر آن‌بن شد." });
    await ctx.api.sendMessage(targetId, "✅ دسترسی شما به ربات دوباره فعال شد.").catch(() => {});
  });

  composer.callbackQuery(/^admin:user:toggleverify:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match![1]);
    const target = await getUser(targetId);
    if (!target) {
      await ctx.answerCallbackQuery();
      return;
    }
    const updated = await setVerified(targetId, !target.verified);
    await logAdminAction(ctx.from!.id, "toggle_verify", String(targetId));
    await ctx.answerCallbackQuery({ text: updated?.verified ? "وریفای شد ✅" : "وریفای برداشته شد" });
    // The user gets a notice (with photo) about the change.
    await notifyVerificationChange(ctx.api, targetId, !!updated?.verified);
  });

  composer.callbackQuery(/^admin:userlist:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await sendUserListPage(ctx, Number(ctx.match![1]));
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();

    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.userList) {
      await sendUserListPage(ctx, 0);
      return;
    }
    if (text === ADMIN_MENU_LABELS.search || text === ADMIN_MENU_LABELS.fullProfile) {
      await setAdminFlow(ctx.from!.id, { flow: "user_lookup", stage: "await_query" });
      await ctx.reply("آیدی تلگرام، آیدی ناشناس، یا یوزرنیم کاربر رو بفرست:", { reply_markup: cancelKeyboard() });
      return;
    }
    if (text === ADMIN_MENU_LABELS.ban) {
      await setAdminFlow(ctx.from!.id, { flow: "ban", stage: "await_query" });
      await ctx.reply("آیدی تلگرامی کاربری که می‌خوای بن کنی رو بفرست:", { reply_markup: cancelKeyboard() });
      return;
    }
    if (text === ADMIN_MENU_LABELS.unban) {
      await setAdminFlow(ctx.from!.id, { flow: "unban", stage: "await_query" });
      await ctx.reply("آیدی تلگرامی کاربری که می‌خوای آن‌بن کنی رو بفرست:", { reply_markup: cancelKeyboard() });
      return;
    }
    if (text === ADMIN_MENU_LABELS.verify) {
      await setAdminFlow(ctx.from!.id, { flow: "verify", stage: "await_query" });
      await ctx.reply("آیدی تلگرامی کاربری که می‌خوای وریفای/لغو وریفای کنی رو بفرست:", { reply_markup: cancelKeyboard() });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.stage !== "await_query") return next();
    if (!["user_lookup", "ban", "unban", "verify"].includes(flow.flow)) return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    const results = await searchUsers(text, 5);
    if (results.length === 0) {
      await ctx.reply("کاربری پیدا نشد.");
      return;
    }
    const target = results[0]!;
    await setAdminFlow(ctx.from!.id, null);

    if (flow.flow === "ban") {
      await setBanned(target._id, true, "توسط ادمین");
      await logAdminAction(ctx.from!.id, "ban_user", String(target._id));
      await ctx.reply(`✅ ${target.anonId} بن شد.`);
      await ctx.api.sendMessage(target._id, "🚫 دسترسی شما به ربات توسط ادمین مسدود شد.").catch(() => {});
      return;
    }
    if (flow.flow === "unban") {
      await setBanned(target._id, false);
      await logAdminAction(ctx.from!.id, "unban_user", String(target._id));
      await ctx.reply(`✅ ${target.anonId} آن‌بن شد.`);
      await ctx.api.sendMessage(target._id, "✅ دسترسی شما به ربات دوباره فعال شد.").catch(() => {});
      return;
    }
    if (flow.flow === "verify") {
      const updated = await setVerified(target._id, !target.verified);
      await logAdminAction(ctx.from!.id, "toggle_verify", String(target._id));
      const notified = await notifyVerificationChange(ctx.api, target._id, !!updated?.verified);
      const notifiedLine = notified ? "\n📨 اعلان برای کاربر ارسال شد." : "\n⚠️ اعلان به کاربر نرسید (احتمالاً ربات رو بلاک کرده).";
      await ctx.reply((updated?.verified ? `✅ ${target.anonId} وریفای شد.` : `${target.anonId} وریفای برداشته شد.`) + notifiedLine);
      return;
    }
    await showFullProfile(ctx, target);
  });
}

const USERS_PER_PAGE = 10;
async function sendUserListPage(ctx: NavaContext, page: number) {
  const { users, total } = await listUsersPage(page * USERS_PER_PAGE, USERS_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(total / USERS_PER_PAGE));

  const lines = users.map((u) => `• ${u.telegramId} — ${u.anonId} — ${u.nickname ?? "-"} — ${levelDisplay(u.level)}`);
  const navRow = [];
  if (page > 0) navRow.push(glassButton("◀️ قبلی", `admin:userlist:${page - 1}`, "primary"));
  if (page < totalPages - 1) navRow.push(glassButton("بعدی ▶️", `admin:userlist:${page + 1}`, "primary"));

  await ctx.reply(`👥 کاربران (صفحه ${page + 1}/${totalPages} — مجموع ${total})\n\n${lines.join("\n") || "خالی"}`, {
    reply_markup: navRow.length > 0 ? inlineKeyboard([navRow]) : undefined,
  });
}
