import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { escapeHtml } from "../../utils/html.js";
import { isAdmin } from "./constants.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { GIFTS } from "../../services/nava/giftCatalog.js";
import { getMiniSettings, setGiftEnabled, setGiftPrice, setPostsChannel, setPostsChannelEnabled } from "../../services/nava/settings.js";

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
  const s = await getMiniSettings();
  const lines = GIFTS.map((g) => `${g.emoji} ${g.name} — ${s.giftPrices[g.id] ?? g.price} رلیک${s.giftsDisabled[g.id] ? " (غیرفعال)" : ""}`);
  const rows = GIFTS.map((g) => [glassButton(`${g.emoji} ${g.name}`, `${NG_CB.gift}${g.id}`, "primary")]);
  rows.push([glassButton("↩️ بازگشت", NG_CB.open, "primary")]);
  return { text: `🎁 <b>هدیه‌های نوا گرام</b>\n\nقیمت‌ها به رلیک هستن و از حساب فرستنده کم میشن.\n\n${lines.join("\n")}`, reply_markup: inlineKeyboard(rows) };
}

async function giftScreen(giftId: string) {
  const g = GIFTS.find((x) => x.id === giftId);
  if (!g) return null;
  const s = await getMiniSettings();
  const price = s.giftPrices[g.id] ?? g.price;
  const off = !!s.giftsDisabled[g.id];
  return {
    text: `${g.emoji} <b>${escapeHtml(g.name)}</b>\n\nقیمت: ${price} رلیک\nوضعیت: ${off ? "🔴 غیرفعال" : "🟢 فعال"}`,
    reply_markup: inlineKeyboard([
      [glassButton("تغییر قیمت", `${NG_CB.giftPrice}${g.id}`, "primary")],
      [glassButton(off ? "فعال کردن" : "غیرفعال کردن", `${NG_CB.giftToggle}${g.id}`, off ? "success" : "danger")],
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

  composer.callbackQuery(new RegExp(`^${NG_CB.gift}([a-z]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const v = await giftScreen(ctx.match![1]!);
    if (v) await show(ctx, v);
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftToggle}([a-z]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    const g = GIFTS.find((x) => x.id === id);
    if (!g) return void (await ctx.answerCallbackQuery());
    const s = await getMiniSettings();
    await setGiftEnabled(id, !!s.giftsDisabled[id]);
    await logAdminAction(ctx.from!.id, "navagram_gift_toggle", `${id}:${!!s.giftsDisabled[id]}`);
    await ctx.answerCallbackQuery();
    const v = await giftScreen(id);
    if (v) await show(ctx, v);
  });

  composer.callbackQuery(new RegExp(`^${NG_CB.giftPrice}([a-z]+)$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match![1]!;
    if (!GIFTS.some((x) => x.id === id)) return void (await ctx.answerCallbackQuery());
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
      if (!GIFTS.some((g) => g.id === giftId) || !Number.isInteger(n) || n < 1 || n > MAX_GIFT_PRICE) {
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
