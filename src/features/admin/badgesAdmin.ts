import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { BADGES, MAX_BADGES, cleanBadges } from "../../config/badges.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getUser } from "../../db/models/user.js";
import { setBadgesById } from "../../services/nava/staffMod.js";
import { isAdmin } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";

/** «🏅 بج‌ها»: the admin sends a numeric Telegram id, then toggles badges on/off. Verification (blue tick) stays in «وریفای». */
const FLOW = "badges";

async function view(userId: number) {
  const u = await getUser(userId);
  if (!u) return null;
  const have = cleanBadges((u as any).badges);
  const rows = [];
  for (let i = 0; i < BADGES.length; i += 2) {
    rows.push(
      BADGES.slice(i, i + 2).map((b, j) =>
        glassButton(`${have.includes(b.id) ? "✅" : "▫️"} ${b.label}`, `admin:bdg:${userId}:${i + j}`, have.includes(b.id) ? "success" : "primary"),
      ),
    );
  }
  rows.push([glassButton("🧹 حذف همه", `admin:bdg:${userId}:clr`, "danger")]);
  return {
    text:
      `🏅 <b>بج‌های کاربر ${userId}</b>${u.verified ? " (وریفای ✔️)" : ""}\n\n` +
      `روی هر بج بزن تا روشن/خاموش بشه. حداکثر ${MAX_BADGES} بج. بج‌های «تیک» به‌جای تیک آبی، تیکِ رنگی کنار اسم نشون میدن.`,
    reply_markup: inlineKeyboard(rows),
  };
}

export function registerAdminBadges(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const text = ctx.message.text.trim();
    if (text === ADMIN_MENU_LABELS.badges) {
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "await_id" });
      await ctx.reply("آیدی عددی تلگرام کاربر رو بفرست (برای لغو: /cancel):");
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "await_id") return next();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const id = Number(text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
    const v = Number.isSafeInteger(id) && id > 0 ? await view(id) : null;
    if (!v) {
      await ctx.reply("کاربری با این آیدی پیدا نشد. دوباره بفرست یا /cancel بزن.");
      return;
    }
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup });
  });

  composer.callbackQuery(/^admin:bdg:(\d+):(\d+|clr)$/, async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery({ text: "دسترسی نداری", show_alert: true }));
    const uid = Number(ctx.match![1]);
    const op = String(ctx.match![2]);
    const u = await getUser(uid);
    if (!u) return void (await ctx.answerCallbackQuery({ text: "کاربر پیدا نشد", show_alert: true }));
    let next = cleanBadges((u as any).badges);
    if (op === "clr") next = [];
    else {
      const b = BADGES[Number(op)];
      if (!b) return void (await ctx.answerCallbackQuery());
      if (next.includes(b.id)) next = next.filter((x) => x !== b.id);
      else if (next.length >= MAX_BADGES) return void (await ctx.answerCallbackQuery({ text: `حداکثر ${MAX_BADGES} بج`, show_alert: true }));
      else next = [...next, b.id];
    }
    await setBadgesById(ctx.from!.id, uid, next);
    await ctx.answerCallbackQuery({ text: "ذخیره شد" });
    const v = await view(uid);
    if (v) await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup }).catch(() => {});
  });
}
