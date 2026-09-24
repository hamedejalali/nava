import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { buttonIcon } from "../../config/emojis.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { countVerifiedUsers, listVerifiedUsersPage } from "../../db/models/user.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

const PER_PAGE = 10;
const CB = { list: "admin:verified:list:" }; // + page index

async function renderList(ctx: NavaContext, page: number, edit: boolean) {
  const total = await countVerifiedUsers();
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const users = await listVerifiedUsersPage(safePage * PER_PAGE, PER_PAGE);

  const lines = users.map(
    (u, i) => `${safePage * PER_PAGE + i + 1}. ${u.nickname ?? "-"} — @${u.anonId} — ${u.telegramId}`
  );
  const text =
    `✅ کاربران وریفای (صفحه ${safePage + 1}/${totalPages} — مجموع ${total})\n\n` +
    (lines.length > 0 ? lines.join("\n") : "هنوز کاربری وریفای نشده.");

  const nav = [];
  if (safePage > 0) nav.push(glassButton("قبلی", `${CB.list}${safePage - 1}`, "primary"));
  if (safePage < totalPages - 1) nav.push(glassButton("بعدی", `${CB.list}${safePage + 1}`, "primary"));
  const reply_markup = nav.length > 0 ? inlineKeyboard([nav]) : undefined;

  if (edit) {
    await ctx.editMessageText(text, { reply_markup }).catch(() => {});
  } else {
    await ctx.reply(text, { reply_markup });
  }
}

export function registerAdminVerifiedUsers(composer: Composer<NavaContext>) {
  // Tap on the admin-panel button: show the COUNT + a button to see the list.
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    if (ctx.message.text.trim() !== ADMIN_MENU_LABELS.verifiedUsers) return next();

    const total = await countVerifiedUsers();
    await ctx.reply(`✅ تعداد کاربران وریفای‌شده: ${total}`, {
      reply_markup: inlineKeyboard([[glassButton("مشاهده کاربران وریفای", `${CB.list}0`, "success", buttonIcon("USERS"))]]),
    });
  });

  composer.callbackQuery(new RegExp(`^${CB.list}(\\d+)$`), async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    const page = Number(ctx.match![1]);
    // First open comes from the count message -> send a NEW message with the
    // list; next/prev edit that list message in place.
    const msg = ctx.callbackQuery.message;
    const isListMessage = !!msg && "text" in msg && !!msg.text?.startsWith("✅ کاربران وریفای");
    await renderList(ctx, page, isListMessage);
  });
}
