import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { searchUsers, setUserLevel, USER_LEVELS, type UserLevel } from "../../db/models/user.js";
import { LEVEL_META, levelDisplay } from "../../config/levels.js";
import { isOwner } from "./constants.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

function levelPickerKeyboard(targetId: number) {
  const buttons = USER_LEVELS.map((lvl, i) =>
    glassButton(LEVEL_META[lvl].label, `admin:level:set:${targetId}:${lvl}`, (["primary", "success", "danger"] as const)[i % 3]!)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return inlineKeyboard(rows);
}

export function registerAdminLevels(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.level) {
      await setAdminFlow(ctx.from!.id, { flow: "level", stage: "await_query" });
      await ctx.reply("آیدی تلگرام یا @آیدی‌ناشناس کاربری که می‌خوای سطحش رو تغییر بدی رو بفرست:");
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "level" || flow.stage !== "await_query") return next();

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
    await ctx.reply(`سطح فعلی @${target.anonId}: ${levelDisplay(target.level)}\n\nسطح جدید رو انتخاب کن:`, {
      reply_markup: levelPickerKeyboard(target._id),
    });
  });

  composer.callbackQuery(/^admin:level:set:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwner(ctx)) return;
    const targetId = Number(ctx.match![1]);
    const level = ctx.match![2] as UserLevel;
    if (!USER_LEVELS.includes(level)) {
      await ctx.answerCallbackQuery();
      return;
    }

    await setUserLevel(targetId, level);
    await logAdminAction(ctx.from!.id, "set_level", `${targetId} -> ${level}`);
    await ctx.answerCallbackQuery({ text: "سطح به‌روزرسانی شد ✅" });
    await ctx.editMessageText(`سطح جدید: ${levelDisplay(level)}`).catch(() => {});
    await ctx.api.sendMessage(targetId, `🎉 سطح کاربری شما به‌روزرسانی شد: ${levelDisplay(level)}`, { parse_mode: "HTML" }).catch(() => {});
  });
}
