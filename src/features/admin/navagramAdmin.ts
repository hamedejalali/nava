import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { escapeHtml } from "../../utils/html.js";
import { isAdmin } from "./constants.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { giftCatalog } from "../../services/nava/gifts.js";
import { removeCustomGift } from "../../services/nava/giftDefs.js";
import { getMiniSettings, setGiftEnabled, setGiftPrice, setGiftUnique, setPostsChannel, setPostsChannelEnabled } from "../../services/nava/settings.js";
import { GF } from "./giftsAdmin.js";

/**
 * Owner/admin panel of «نوا گرام» (reached from ⚙️ تنظیمات ربات): the post-copy channel switch,
 * its channel, and the gift catalogue (price in Relic + on/off). Everything is stored in MongoDB.
 */

export const NG_CB = {
  open: "admin:ng:open",
  toggleChannel: "admin:ng:tch",
  setChannel: "admin:ng:sch",
  clearChannel: "admin:ng:cch",
  gifts: "admin:ng:gifts",
  gift: "admin:ng:g:", // + giftId
  giftToggle: "admin:ng:gt:", // + giftId
  giftPrice: "admin:ng:gp:", // + giftId
  giftUnique: "admin:ng:gu:", // + giftId
  giftDelete: "admin:ng:gd:", // + giftId (custom/Telegram gifts only)
};
const FLOW = "navagram";
export const MAX_GIFT_PRICE = 100_000;

export async function navagramScreen(): Promise<{ text: string; reply_markup: ReturnType<typeof inlineKeyboard> }> {
  const s = await getMiniSettings();
  const ch = s.postsChannelId ? `${s.postsChannelTitle ? escapeHtml(s.postsChannelTitle) + " — " : ""}<code>${s.postsChannelId}</code>` : "— تنظیم نشده —";
  const text =
    `📸 <b>تنظیمات نوا گرام</b>\n\n` +
    `کپی پست‌ها در کانال: ${s.postsChannelEnabled ? "🟢 روشن" : "🔴 خاموش"}\n` +
    `کانال: ${ch}\n\n` +
    `وقتی روشنه، از هر پست جدید فقط <b>یک</b> کپی (عکس + کپشن + نام نویسنده) داخل کانال فرستاده میشه. پست‌ها نیاز به تأیید ندارن؛ فقط عکس پروفایل تأیید مالک می‌خواد.\n` +
    (s.postsChannelEnabled && !s.postsChannelId ? `\n⚠️ کانال تنظیم نشده؛ تا وقتی کانال نذاری کپی‌ای فرستاده نمیشه.\n` : "");
  const rows = [
    [glassButton(s.postsChannelEnabled ? "خاموش کردن کپی در کانال" : "روشن کردن کپی در کانال", NG_CB.toggleChannel, s.postsChannelEnabled ? "danger" : "success")],
    [glassButton("تنظیم / تغییر کانال", NG_CB.setChannel, "primary")],
    ...(s.postsChannelId ? [[glassButton("حذف کانال", NG_CB.clearChannel, "danger")]] : []),
    [glassButton("🎁 هدیه‌ها و قیمت‌ها", NG_CB.gifts, "primary")],
  ];
  return { text, reply_markup: inlineKeyboard(rows) };
}

async function giftsScreen() {
  const cards = await giftCatalog(true);
  const lines = cards.map((g) => `${g.emoji} ${g.name} — ${g.price} رلیک${g.unique ? (g.soldOut ? " ✨یکتا (فروخته شد)" : " ✨یکتا") : ""}${g.custom ? " 🎞" : ""}${g.off ? " (غیرفعال)" : ""}`);
  const rows = cards.map((g) => [glassButton(`${g.emoji} ${g.name}${g.off ? " (غیرفعال)" : ""}`, `${NG_CB.gift}${g.id}`, "primary")]);
  rows.push([glassButton("➕ هدیه‌ی تلگرامی جدید", GF.add, "success")]);
  rows.push([glassButton("🔨 حراج و قرعه‌کشی", GF.ev, "primary"), glassButton("👤 هدیه‌های یک کاربر", GF.users, "primary")]);
  rows.push([glassButton("↩️ بازگشت", NG_CB.open, "primary")]);
  return { text: `🎁 <b>هدیه‌های نوا گرام</b>\n\nقیمت‌ها به رلیک هستن و از حساب فرستنده کم میشن. 🎞 = انیمیشن تلگرامی، ✨ = فقط یک نسخه.\n\n${lines.join("\n")}`, reply_markup: inlineKeyboard(rows) };
}

async function giftScreen(giftId: string) {
  const g = (await giftCatalog(true)).find((x) => x.id === giftId);
  if (!g) return null;
  const off = g.off;
  return {
    text: `${g.emoji} <b>${escapeHtml(g.name)}</b>\n\nقیمت: ${g.price} رلیک\nوضعیت: ${off ? "🔴 غیرفعال" : "🟢 فعال"}\nنسخه‌ی یکتا: ${g.unique ? (g.soldOut ? "✨ بله (فروخته شده)" : "✨ بله (هنوز فروخته نشده)") : "نه"}${g.custom ? "\nنوع: 🎞 هدیه‌ی انیمیشنی تلگرام" : ""}`,
    reply_markup: inlineKeyboard([
      [glassButton("تغییر قیمت", `${NG_CB.giftPrice}${g.id}`, "primary")],
      [glassButton(off ? "فعال کردن" : "غیرفعال کردن", `${NG_CB.giftToggle}${g.id}`, off ? "success" : "danger")],
      [glassButton(g.unique ? "برداشتن حالت یکتا" : "✨ یکتا کردن (فقط یک نسخه)", `${NG_CB.giftUnique}${g.id}`, "primary")],
      ...(g.custom ? [[glassButton("🗑 حذف این هدیه", `${NG_CB.giftDelete}${g.id}`, "danger")]] : []),
      [glassButton("↩️ بازگشت", NG_CB.gifts, "primary")],
    ]),
  };
}

export function registerNavagramAdmin(composer: Composer<NavaContext>) {
  const show = async (ctx: NavaContext, view: { text: string; reply_markup: any }) => {
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.reply_markup }).catch(async () => {
      await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.reply_markup });
    });
  };

  composer.callbackQuery(NG_CB.open, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, null);
    await show(ctx, await navagramScreen());
  });

  composer.callbackQuery(NG_CB.toggleChannel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getMiniSettings();
    await setPostsChannelEnabled(!s.postsChannelEnabled);
    await logAdminAction(ctx.from!.id, "navagram_channel_copy", String(!s.postsChannelEnabled));
    await ctx.answerCallbackQuery({ text: !s.postsChannelEnabled ? "روشن شد" : "خاموش شد" });
    await show(ctx, await navagramScreen());
  });

  composer.callbackQuery(NG_CB.setChannel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "channel" });
    await ctx.reply(
      "آیدی عددی کانال (مثل -1001234567890) یا @یوزرنیم کانال رو بفرست؛ یا یه پیام از کانال رو فوروارد کن.\nربات باید داخل اون کانال ادمین باشه و اجازهٔ ارسال پیام داشته باشه.",
      { reply_markup: cancelKeyboard() }
    );
  });

  composer.callbackQuery(NG_CB.clearChannel, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await setPostsChannel(null, null);
    await setPostsChannelEnabled(false);
    await logAdminAction(ctx.from!.id, "navagram_channel_clear", "");
    await ctx.answerCallbackQuery({ text: "کانال حذف و کپی خاموش شد" });
    await show(ctx, await navagramScreen());
  });

  composer.callbackQuery(NG_CB.gifts, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, null);
    await show(ctx, await giftsScreen());
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.gift}([a-z0-9]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const v = await giftScreen(ctx.match![1]!);
    if (v) await show(ctx, v);
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftToggle}([a-z0-9]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    const g = (await giftCatalog(true)).find((x) => x.id === id);
    if (!g) return void (await ctx.answerCallbackQuery());
    await setGiftEnabled(id, g.off);
    await logAdminAction(ctx.from!.id, "navagram_gift_toggle", `${id}:${g.off}`);
    await ctx.answerCallbackQuery();
    const v = await giftScreen(id);
    if (v) await show(ctx, v);
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftUnique}([a-z0-9]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    const g = (await giftCatalog(true)).find((x) => x.id === id);
    if (!g) return void (await ctx.answerCallbackQuery());
    await setGiftUnique(id, !g.unique);
    await logAdminAction(ctx.from!.id, "navagram_gift_unique", `${id}:${!g.unique}`);
    await ctx.answerCallbackQuery({ text: !g.unique ? "حالا فقط یک نسخه از این هدیه فروخته میشه" : "حالت یکتا برداشته شد" });
    const v = await giftScreen(id);
    if (v) await show(ctx, v);
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftDelete}(tg[a-z0-9]{6})$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const r = await removeCustomGift(ctx.match![1]!);
    await logAdminAction(ctx.from!.id, "navagram_gift_remove", `${ctx.match![1]}:${r}`);
    await ctx.answerCallbackQuery({ text: r === "deleted" ? "هدیه حذف شد" : r === "disabled" ? "چند نفر این هدیه رو دارن؛ فقط غیرفعال شد (هدیه‌های قبلی سر جاشون می‌مونن)" : "پیدا نشد", show_alert: r === "disabled" });
    await show(ctx, await giftsScreen());
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftPrice}([a-z0-9]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    if (!(await giftCatalog(true)).some((x) => x.id === id)) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "price", data: { giftId: id } });
    await ctx.reply(`قیمت جدید (به رلیک، عدد صحیح بین ۱ تا ${MAX_GIFT_PRICE}) رو بفرست:`, { reply_markup: cancelKeyboard() });
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    if (flow.stage === "price") {
      const giftId = String(flow.data?.giftId ?? "");
      const n = Number(text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      if (!(await giftCatalog(true)).some((g) => g.id === giftId) || !Number.isInteger(n) || n < 1 || n > MAX_GIFT_PRICE) {
        await ctx.reply(`قیمت باید یه عدد صحیح بین ۱ تا ${MAX_GIFT_PRICE} باشه.`, { reply_markup: cancelKeyboard() });
        return;
      }
      await setGiftPrice(giftId, n);
      await logAdminAction(ctx.from!.id, "navagram_gift_price", `${giftId}:${n}`);
      await setAdminFlow(ctx.from!.id, null);
      const v = await giftScreen(giftId);
      if (v) await ctx.reply(`✅ قیمت ذخیره شد.\n\n${v.text}`, { parse_mode: "HTML", reply_markup: v.reply_markup });
      return;
    }

    if (flow.stage === "channel") {
      const fwd: any = (ctx.message as any).forward_origin;
      let ref: string | number | null = null;
      if (fwd?.type === "channel" && fwd.chat?.id) ref = fwd.chat.id;
      else if (/^-100\d{5,}$/.test(text)) ref = Number(text);
      else if (/^@[A-Za-z0-9_]{4,}$/.test(text)) ref = text;
      if (ref === null) {
        await ctx.reply("آیدی معتبر نیست. مثل -1001234567890 یا @mychannel بفرست.", { reply_markup: cancelKeyboard() });
        return;
      }
      try {
        const chat = await ctx.api.getChat(ref);
        if (chat.type !== "channel" && chat.type !== "supergroup" && chat.type !== "group") throw new Error("not a channel");
        const me = await ctx.api.getChatMember(chat.id, ctx.me.id);
        if (me.status !== "administrator" && me.status !== "creator") throw new Error("not admin");
        await setPostsChannel(chat.id, "title" in chat ? (chat.title ?? null) : null);
        await logAdminAction(ctx.from!.id, "navagram_channel_set", String(chat.id));
        await setAdminFlow(ctx.from!.id, null);
        const v = await navagramScreen();
        await ctx.reply(`✅ کانال ذخیره شد.\n\n${v.text}`, { parse_mode: "HTML", reply_markup: v.reply_markup });
      } catch {
        await ctx.reply("نتونستم به این کانال دسترسی پیدا کنم. مطمئن شو ربات داخلش ادمینه و آیدی درسته، بعد دوباره بفرست.", { reply_markup: cancelKeyboard() });
      }
      return;
    }
    return next();
  });
}
