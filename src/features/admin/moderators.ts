import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { searchUsers, setAdminRole } from "../../db/models/user.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { isOwner } from "./constants.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getDb } from "../../db/connect.js";
import { PERMS, effectivePerms, isPermKey, type PermKey } from "./permissions.js";

const PERM_CB = /^adm:perm:(\d+):([A-Za-z]+)$/;

async function permsView(targetId: number) {
  const u = await (await getDb()).collection<any>("users").findOne({ _id: targetId });
  const eff = effectivePerms(u);
  const keys = Object.keys(PERMS) as PermKey[];
  const rows = keys.map((k) => [glassButton(`${eff[k] ? "✅" : "❌"} ${PERMS[k]}`, `adm:perm:${targetId}:${k}`, eff[k] ? "success" : "danger")]);
  rows.push([glassButton("✔️ پایان", `adm:perm:${targetId}:done`, "primary")]);
  return { text: `🔑 دسترسی‌های ${u?.nickname ?? ""} (${u?.anonId ?? targetId})\nهر دکمه رو بزن تا روشن/خاموش بشه:`, kb: inlineKeyboard(rows), eff };
}
async function sendPerms(ctx: NavaContext, targetId: number) {
  const v = await permsView(targetId);
  await ctx.reply(v.text, { reply_markup: v.kb });
}

export function registerAdminModerators(composer: Composer<NavaContext>) {
  composer.callbackQuery(PERM_CB, async (ctx) => {
    if (!isOwner(ctx)) return void ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true });
    const m = PERM_CB.exec(ctx.callbackQuery.data)!;
    const targetId = Number(m[1]);
    if (m[2] === "done") {
      await ctx.answerCallbackQuery({ text: "ذخیره شد ✅" });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (!isPermKey(m[2]!)) return void ctx.answerCallbackQuery();
    const key = m[2] as PermKey;
    const users = (await getDb()).collection<any>("users");
    const u = await users.findOne({ _id: targetId });
    if (!u?.isAdmin) return void ctx.answerCallbackQuery({ text: "این کاربر ادمین نیست", show_alert: true });
    const now = !effectivePerms(u)[key];
    await users.updateOne({ _id: targetId }, { $set: { [`adminPerms.${key}`]: now } });
    await logAdminAction(ctx.from!.id, "admin_perms", `${targetId}:${key}=${now ? "on" : "off"}`);
    const v = await permsView(targetId);
    await ctx.editMessageText(v.text, { reply_markup: v.kb }).catch(() => {});
    await ctx.answerCallbackQuery();
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.moderators) {
      await setAdminFlow(ctx.from!.id, { flow: "moderators", stage: "await_query" });
      await ctx.reply(
        "آیدی تلگرام یا آیدی ناشناس کاربر رو بفرست.\n" +
          "بعدش می‌تونی «افزودن» یا «حذف» ادمین رو انتخاب کنی.",
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    if (text === ADMIN_MENU_LABELS.adminAccess) {
      await setAdminFlow(ctx.from!.id, { flow: "moderators", stage: "await_query", data: { permsOnly: true } });
      await ctx.reply("آیدی تلگرام یا آیدی ناشناس ادمین رو بفرست تا دسترسی‌هاش رو ببینی/تغییر بدی.", { reply_markup: cancelKeyboard() });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "moderators") return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    if (flow.stage === "await_query") {
      const results = await searchUsers(text, 5);
      if (results.length === 0) {
        await ctx.reply("کاربری پیدا نشد.");
        return;
      }
      const target = results[0]!;
      if (flow.data?.permsOnly) {
        await setAdminFlow(ctx.from!.id, null);
        if (!target.isAdmin) {
          await ctx.reply("این کاربر ادمین نیست. اول از «مدیریت Moderator / Admin» اضافه‌اش کن.");
          return;
        }
        await sendPerms(ctx, target._id);
        return;
      }
      await setAdminFlow(ctx.from!.id, { flow: "moderators", stage: "await_action", data: { targetId: target._id } });
      await ctx.reply(
        `کاربر: ${target.anonId} — ادمین فعلاً: ${target.isAdmin ? "✅" : "❌"}\n\n` +
          `بفرست: «افزودن» برای دادن دسترسی ادمین، یا «حذف» برای گرفتنش`
      );
      return;
    }

    if (flow.stage === "await_action") {
      const targetId = flow.data?.targetId as number;
      if (text === "افزودن") {
        await setAdminRole(targetId, true);
        await logAdminAction(ctx.from!.id, "grant_admin", String(targetId));
        await ctx.reply("✅ ادمین اضافه شد. حالا مشخص کن به چه بخش‌هایی دسترسی داشته باشه (ژتونی که ادمین می‌فرسته از موجودی خودش کم میشه؛ از «مدیریت ژتون» می‌تونی شارژش کنی):");
        await sendPerms(ctx, targetId);
        await ctx.api.sendMessage(targetId, "🛡️ شما به عنوان ادمین ربات مویا منصوب شدید.").catch(() => {});
      } else if (text === "حذف") {
        await setAdminRole(targetId, false);
        await logAdminAction(ctx.from!.id, "revoke_admin", String(targetId));
        await ctx.reply("✅ دسترسی ادمین گرفته شد.");
        await ctx.api.sendMessage(targetId, "⚠️ دسترسی ادمین شما در ربات مویا لغو شد.").catch(() => {});
      } else {
        await ctx.reply('لطفاً "افزودن" یا "حذف" رو بفرست.');
        return;
      }
      await setAdminFlow(ctx.from!.id, null);
    }
  });
}
