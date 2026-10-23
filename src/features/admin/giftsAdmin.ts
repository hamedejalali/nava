import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { getDb } from "../../db/connect.js";
import { escapeHtml } from "../../utils/html.js";
import { isAdmin, isOwner } from "./constants.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { giftCatalog } from "../../services/nava/gifts.js";
import { cleanGlyph, addCustomGift, MAX_GIFT_NAME, MAX_GIFT_PRICE, stickerFormatOf, type StickerFormat } from "../../services/nava/giftDefs.js";
import { adminDeleteGift, adminTakeGift, listUserGifts } from "../../services/nava/giftAdmin.js";
import { createGiftEvent, getGiftEvent, listOpenEvents, MAX_EVENT_HOURS, MAX_WINNERS, settleGiftEvent } from "../../services/nava/giftEvents.js";
import { importPack, parsePack, DEFAULT_PACK_PRICE } from "../../services/nava/giftPack.js";
import { env } from "../../config/env.js";
import { getMiniSettings } from "../../services/nava/settings.js";

/**
 * Owner tools around gifts (inside «نوا گرام» ← «هدیه‌ها»):
 *  - add a gift that looks exactly like a Telegram gift (the official gift list from the Bot API, or any sticker the owner sends);
 *  - see the gifts of any user and delete one / take it for himself (owner only);
 *  - auctions and giveaways in the channel (owner only).
 * Everything is stored in MongoDB.
 */

export const GF = {
  add: "admin:gf:add",
  official: "admin:gf:tg",
  pack: "admin:gf:pk",
  pick: "admin:gf:tp:", // + index in the fetched list
  ev: "admin:gf:ev",
  evNew: "admin:gf:en:", // + a | g
  evGift: "admin:gf:eg:", // + a|g + ":" + giftId
  evList: "admin:gf:el",
  evEnd: "admin:gf:ee:", // + eventId
  evCancel: "admin:gf:ec:", // + eventId
  users: "admin:gf:ug",
  del: "admin:gf:ud:", // + gift pub
  take: "admin:gf:ut:", // + gift pub
};
const FLOW = "navagifts";
const BACK_GIFTS = "admin:ng:gifts";
const faDigits = (t: string) => t.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
const PUB = "([A-Za-z0-9_-]{6,24})";

interface Pick {
  fileId: string;
  uniqueId: string;
  format: StickerFormat;
  emoji: string;
  stars?: number;
}

/** «➕ هدیه‌ی جدید»: the owner sends a sticker / a cut-out PNG (as a FILE, to keep the transparency) / a photo, or picks an official Telegram gift. */
export async function openAddGift(ctx: NavaContext) {
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "sticker" });
  await ctx.reply(
    "🎁 <b>هدیه‌ی جدید</b>\n\nیکی از اینا رو بفرست:\n" +
      "• 🖼 <b>عکس بریده‌شده (PNG شفاف)</b> — حتماً به‌صورت <b>فایل (File)</b> بفرست تا پس‌زمینه‌ش شفاف بمونه؛ داخل هدیه آروم تکون می‌خوره و شناور میشه\n" +
      "• 🎞 استیکر (انیمیشنی، ویدیویی یا ثابت)\n" +
      "• 📷 عکس معمولی (پس‌زمینه‌ی شفاف نداره)\n" +
      "یا از لیست هدیه‌های رسمی تلگرام انتخاب کن:",
    { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("🎁 هدیه‌های رسمی تلگرام", GF.official, "success")], [glassButton("↩️ بازگشت", BACK_GIFTS, "primary")]]) }
  );
}

export async function openUserGiftsPrompt(ctx: NavaContext) {
  await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "userRef" });
  await ctx.reply("آیدی عددی تلگرام یا آیدی ناشناس (user_…) یا @یوزرنیم کاربر رو بفرست:", { reply_markup: cancelKeyboard() });
}

export const GIFT_EVENTS_HOME = {
  text: "🔨 <b>حراج و قرعه‌کشی هدیه</b>\n\nپست توی «کانال حراج و قرعه‌کشی» (کانال جدا؛ از «کانال و تنظیمات نوا گرام» تنظیمش کن) منتشر میشه و همون پست ادیت میشه.\nدر حراج، XP پیشنهاد دهنده همون لحظه نگه داشته میشه و با پیشنهاد بالاتر خودکار برمی‌گرده.",
  reply_markup: inlineKeyboard([
    [glassButton("🔨 حراج جدید", `${GF.evNew}a`, "success"), glassButton("🎉 قرعه‌کشی جدید", `${GF.evNew}g`, "success")],
    [glassButton("📋 رویدادهای باز", GF.evList, "primary")],
    [glassButton("↩️ بازگشت", BACK_GIFTS, "primary")],
  ]),
};

export function registerGiftsAdmin(composer: Composer<NavaContext>) {
  const show = async (ctx: NavaContext, text: string, reply_markup: any) => {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(async () => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup });
    });
  };

  /* ------------------------------------------------------------ add a Telegram gift */
  composer.callbackQuery(GF.add, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await openAddGift(ctx);
  });

  composer.callbackQuery(GF.official, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    let list: Pick[] = [];
    try {
      const res: any = await (ctx.api as any).getAvailableGifts();
      list = (res?.gifts ?? [])
        .filter((g: any) => g?.sticker?.file_id)
        .slice(0, 40)
        .map((g: any): Pick => ({ fileId: g.sticker.file_id, uniqueId: g.sticker.file_unique_id, format: stickerFormatOf(g.sticker), emoji: g.sticker.emoji || "🎁", stars: g.star_count }));
    } catch {
      await ctx.reply("نتونستم لیست هدیه‌های تلگرام رو بگیرم. می‌تونی خودت یه استیکر بفرستی.");
      return;
    }
    if (!list.length) return void (await ctx.reply("لیستی از تلگرام نیومد. یه استیکر بفرست."));
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "sticker", data: { list } });
    const rows = [];
    for (let i = 0; i < list.length; i += 4) rows.push(list.slice(i, i + 4).map((g, j) => glassButton(`${g.emoji} ${g.stars ?? ""}⭐`.trim(), `${GF.pick}${i + j}`, "primary")));
    rows.push([glassButton("↩️ بازگشت", BACK_GIFTS, "primary")]);
    await ctx.reply("یکی از هدیه‌های رسمی تلگرام رو انتخاب کن (عدد = قیمت به Star تلگرام، فقط برای اطلاع):", { reply_markup: inlineKeyboard(rows) });
  });

  composer.callbackQuery(new RegExp(`^${GF.pick}(\\d{1,2})$`), async (ctx) => {
    if (!isAdmin(ctx)) return;
    const flow = await getAdminFlow(ctx.from!.id);
    const pick = ((flow?.data?.list as Pick[] | undefined) ?? [])[Number(ctx.match![1])];
    if (flow?.flow !== FLOW || !pick) return void (await ctx.answerCallbackQuery({ text: "لیست قدیمیه؛ دوباره از اول بزن.", show_alert: true }));
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "name", data: { pick } });
    await ctx.reply(`نام فارسی این هدیه رو بفرست (حداکثر ${MAX_GIFT_NAME} حرف):`, { reply_markup: cancelKeyboard() });
  });

  composer.on("message:sticker", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (flow?.flow !== FLOW || flow.stage !== "sticker") return next();
    const st = ctx.message.sticker;
    const pick: Pick = { fileId: st.file_id, uniqueId: st.file_unique_id, format: stickerFormatOf(st), emoji: st.emoji || "🎁" };
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "name", data: { pick } });
    await ctx.reply(`✅ استیکر دریافت شد (${pick.format === "tgs" ? "انیمیشن" : pick.format === "webm" ? "ویدیو" : "ثابت"}).\nنام فارسی این هدیه رو بفرست (حداکثر ${MAX_GIFT_NAME} حرف):`, { reply_markup: cancelKeyboard() });
  });

  /** a picture as a gift: a cut-out PNG sent as a FILE (transparent), a still sticker handled above, or a normal photo */
  const takePicture = async (ctx: NavaContext, fileId: string, uniqueId: string, format: StickerFormat, size: number | undefined) => {
    if (size && size > 2 * 1024 * 1024) return void (await ctx.reply("حجم عکس بیشتر از ۲ مگابایته؛ یه نسخه‌ی کوچیک‌تر بفرست.", { reply_markup: cancelKeyboard() }));
    const pick: Pick = { fileId, uniqueId, format, emoji: "🎁" };
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "name", data: { pick } });
    await ctx.reply(`✅ عکس دریافت شد${format === "jpg" ? " (عکس معمولیه؛ برای پس‌زمینه‌ی شفاف، PNG رو به‌صورت فایل بفرست)" : " — داخل هدیه آروم شناور میشه"}.\nنام فارسی این هدیه رو بفرست (حداکثر ${MAX_GIFT_NAME} حرف):`, { reply_markup: cancelKeyboard() });
  };

  composer.callbackQuery(GF.pack, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "pack" });
    await ctx.reply(
      "📥 <b>ایمپورت هدیه از فایل</b>\n\nیکی از این فایل‌ها رو بفرست (به‌صورت File):\n" +
        "• <b>.zip</b> — شامل <code>pack.json</code> + فایل‌های انیمیشن (.tgs / Lottie .json / .png / .webp / .webm)؛ بدون pack.json هر فایل یک هدیه میشه\n" +
        "• <b>.json</b> — لیست هدیه‌ها (<code>gifts</code>) یا یک انیمیشن Lottie\n" +
        "• <b>.tgs</b> — یک انیمیشن تلگرام\n\n" +
        "بعد از ایمپورت، قیمت/نام/اموجی/اموجی پس‌زمینه‌ی هر هدیه رو از «🎁 هدیه‌ها و قیمت‌ها» تنظیم کن. فرمت کامل: <code>docs/GIFT_PACK.md</code>",
      { parse_mode: "HTML", reply_markup: cancelKeyboard() }
    );
  });

  composer.on("message:document", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (flow?.flow !== FLOW || (flow.stage !== "sticker" && flow.stage !== "pack")) return next();
    const d = ctx.message.document;
    const fname = (d.file_name ?? "").toLowerCase();
    if (/\.(zip|json|tgs)$/.test(fname) || flow.stage === "pack") {
      if (!/\.(zip|json|tgs)$/.test(fname)) return void (await ctx.reply("فقط فایل zip / json / tgs قبوله.", { reply_markup: cancelKeyboard() }));
      if ((d.file_size ?? 0) > 18 * 1024 * 1024) return void (await ctx.reply("حجم فایل زیاد است (حداکثر ۱۸ مگابایت).", { reply_markup: cancelKeyboard() }));
      try {
        const f = await ctx.api.getFile(d.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.file_path}`);
        if (!res.ok) throw new Error("download");
        const items = parsePack(Buffer.from(await res.arrayBuffer()), fname);
        await ctx.reply(`⏳ ${items.length} هدیه پیدا شد؛ در حال ساخت…`);
        const r = await importPack(ctx.api, ctx.from!.id, items, ctx.from!.id);
        await logAdminAction(ctx.from!.id, "navagram_gift_import", `${r.created.length}/${items.length}`);
        await setAdminFlow(ctx.from!.id, null);
        await ctx.reply(`✅ ${r.created.length} هدیه ساخته شد${r.failed.length ? `\n❌ ناموفق: ${r.failed.map(escapeHtml).join("، ")}` : ""}\n\nقیمت پیش‌فرض ${DEFAULT_PACK_PRICE} XP — از «🎁 هدیه‌ها و قیمت‌ها» نام/قیمت/اموجی هر کدوم رو تنظیم کن.`, { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("🎁 رفتن به هدیه‌ها", BACK_GIFTS, "primary")]]) });
      } catch (e) {
        await ctx.reply(`❌ ${e instanceof Error && e.message ? escapeHtml(e.message) : "ایمپورت انجام نشد."}`, { parse_mode: "HTML", reply_markup: cancelKeyboard() });
      }
      return;
    }
    const mime = (d.mime_type ?? "").toLowerCase();
    const format: StickerFormat | null = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : null;
    if (!format) return void (await ctx.reply("فقط فایل PNG / WebP / JPG قبوله.", { reply_markup: cancelKeyboard() }));
    await takePicture(ctx, d.file_id, d.file_unique_id, format, d.file_size);
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (flow?.flow !== FLOW || flow.stage !== "sticker") return next();
    const p = ctx.message.photo[ctx.message.photo.length - 1]!;
    await takePicture(ctx, p.file_id, p.file_unique_id, "jpg", p.file_size);
  });

  /* ------------------------------------------------------------ gifts of one user */
  composer.callbackQuery(GF.users, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    await ctx.answerCallbackQuery();
    await openUserGiftsPrompt(ctx);
  });

  const userGiftsView = async (userId: number) => {
    const { rows, total } = await listUserGifts(userId, 20);
    if (!rows.length) return { text: `این کاربر هدیه‌ای نداره.`, reply_markup: inlineKeyboard([[glassButton("↩️ بازگشت", BACK_GIFTS, "primary")]]) };
    const lines = rows.map((r, i) => `${i + 1}. ${r.emoji} ${escapeHtml(r.name)} — از <code>${r.senderId}</code>${r.anonymous ? " (ناشناس)" : ""}`);
    const kb = rows.map((r, i) => [glassButton(`🗑 ${i + 1}`, `${GF.del}${r.pub}`, "danger"), glassButton(`⬅️ ${i + 1} برای من`, `${GF.take}${r.pub}`, "success")]);
    kb.push([glassButton("↩️ بازگشت", BACK_GIFTS, "primary")]);
    return { text: `🎁 هدیه‌های کاربر <code>${userId}</code> (${total})\n\n${lines.join("\n")}\n\n🗑 = حذف  |  ⬅️ = انتقال به حساب خودت\n<i>حذف هدیه‌ی «یکتا» اون رو دوباره قابل فروش می‌کنه.</i>`, reply_markup: inlineKeyboard(kb) };
  };

  composer.callbackQuery(new RegExp(`^${GF.del}${PUB}$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await adminDeleteGift(ctx.match![1]!);
    if (r) await logAdminAction(ctx.from!.id, "gift_delete", `${r.ownerId}:${r.giftId}`);
    await ctx.answerCallbackQuery({ text: r ? "حذف شد" : "پیدا نشد (شاید قبلاً حذف یا منتقل شده)" });
    if (r) await show(ctx, (await userGiftsView(r.ownerId)).text, (await userGiftsView(r.ownerId)).reply_markup);
  });

  composer.callbackQuery(new RegExp(`^${GF.take}${PUB}$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await adminTakeGift(ctx.match![1]!, ctx.from!.id);
    if (r) await logAdminAction(ctx.from!.id, "gift_take", `${r.fromId}:${r.giftId}`);
    await ctx.answerCallbackQuery({ text: r ? "به حساب تو منتقل شد" : "پیدا نشد (شاید قبلاً منتقل شده یا مال خودته)" });
    if (r) {
      const v = await userGiftsView(r.fromId);
      await show(ctx, v.text, v.reply_markup);
    }
  });

  /* ------------------------------------------------------------ auctions / giveaways */
  const eventsHome = () => GIFT_EVENTS_HOME;

  composer.callbackQuery(GF.ev, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, null);
    const v = eventsHome();
    await show(ctx, v.text, v.reply_markup);
  });

  composer.callbackQuery(new RegExp(`^${GF.evNew}([ag])$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const s = await getMiniSettings();
    if (!s.eventsChannelId) return void (await ctx.answerCallbackQuery({ text: "اول «کانال حراج و قرعه‌کشی» رو تنظیم کن (از کانال و تنظیمات نوا گرام).", show_alert: true }));
    await ctx.answerCallbackQuery();
    const kind = ctx.match![1]!;
    const cards = await giftCatalog(true);
    const rows = [];
    for (let i = 0; i < cards.length; i += 2) rows.push(cards.slice(i, i + 2).map((g) => glassButton(`${g.emoji} ${g.name}`, `${GF.evGift}${kind}:${g.id}`, "primary")));
    rows.push([glassButton("↩️ بازگشت", GF.ev, "primary")]);
    await show(ctx, `کدوم هدیه رو بذاریم برای ${kind === "a" ? "حراج" : "قرعه‌کشی"}؟\n<i>اگه همون هدیه رو (مثلاً از کسی گرفته باشی) داشته باشی همون استفاده میشه، وگرنه یه نسخه‌ی جدید برای تو ساخته میشه.</i>`, inlineKeyboard(rows));
  });

  composer.callbackQuery(new RegExp(`^${GF.evGift}([ag]):([a-z0-9]+)$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const kind = ctx.match![1]!;
    const giftId = ctx.match![2]!;
    const card = (await giftCatalog(true)).find((c) => c.id === giftId);
    if (!card) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: kind === "a" ? "evPrice" : "evHours", data: { kind, giftId } });
    await ctx.reply(kind === "a" ? `قیمت شروع حراج ${card.emoji} ${card.name} (به XP، ۱ تا ${MAX_GIFT_PRICE}):` : `قرعه‌کشی ${card.emoji} ${card.name} — تا چند ساعت دیگه تموم بشه؟ (۱ تا ${MAX_EVENT_HOURS})`, { reply_markup: cancelKeyboard() });
  });

  const eventsList = async () => {
    const open = await listOpenEvents(15);
    const cards = new Map((await giftCatalog(true)).map((c) => [c.id, c]));
    if (!open.length) return { text: "رویداد بازی وجود نداره.", reply_markup: inlineKeyboard([[glassButton("↩️ بازگشت", GF.ev, "primary")]]) };
    const lines = open.map((e, i) => {
      const c = cards.get(e.giftId);
      const left = Math.max(0, Math.round((e.endsAt.getTime() - Date.now()) / 60000));
      return `${i + 1}. ${e.kind === "auction" ? "🔨" : "🎉"} ${c?.emoji ?? "🎁"} ${escapeHtml(c?.name ?? "")} — ${e.kind === "auction" ? `بالاترین: ${e.topBid || "—"}` : ""} — ${left} دقیقه مونده`;
    });
    const kb = open.map((e, i) => [glassButton(`⏹ پایان همین الان ${i + 1}`, `${GF.evEnd}${e._id}`, "success"), glassButton(`✖️ لغو ${i + 1}`, `${GF.evCancel}${e._id}`, "danger")]);
    kb.push([glassButton("↩️ بازگشت", GF.ev, "primary")]);
    return { text: `📋 <b>رویدادهای باز</b>\n\n${lines.join("\n")}`, reply_markup: inlineKeyboard(kb) };
  };

  composer.callbackQuery(GF.evList, async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    await ctx.answerCallbackQuery();
    const v = await eventsList();
    await show(ctx, v.text, v.reply_markup);
  });

  composer.callbackQuery(new RegExp(`^${GF.evEnd}${PUB}$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await settleGiftEvent(ctx.api, ctx.match![1]!, { force: true });
    await logAdminAction(ctx.from!.id, "gift_event_end", `${ctx.match![1]}:${r?.outcome ?? "noop"}`);
    await ctx.answerCallbackQuery({ text: r ? "تموم شد" : "این رویداد دیگه باز نیست" });
    const v = await eventsList();
    await show(ctx, v.text, v.reply_markup);
  });

  composer.callbackQuery(new RegExp(`^${GF.evCancel}${PUB}$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }));
    const r = await settleGiftEvent(ctx.api, ctx.match![1]!, { cancel: true });
    await logAdminAction(ctx.from!.id, "gift_event_cancel", `${ctx.match![1]}:${r?.outcome ?? "noop"}`);
    await ctx.answerCallbackQuery({ text: r ? "لغو شد (XP پیشنهاد دهنده برگشت)" : "این رویداد دیگه باز نیست" });
    const v = await eventsList();
    await show(ctx, v.text, v.reply_markup);
  });

  /* ------------------------------------------------------------ text steps */
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
    const num = Number(faDigits(text));

    if (flow.stage === "name") {
      const name = text.slice(0, MAX_GIFT_NAME);
      if (!name) return void (await ctx.reply("نام خالیه.", { reply_markup: cancelKeyboard() }));
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "price", data: { pick: flow.data?.pick, name } });
      await ctx.reply(`قیمت این هدیه به XP؟ (عدد صحیح ۱ تا ${MAX_GIFT_PRICE})`, { reply_markup: cancelKeyboard() });
      return;
    }

    if (flow.stage === "price") {
      if (!Number.isInteger(num) || num < 1 || num > MAX_GIFT_PRICE) return void (await ctx.reply(`قیمت باید یه عدد صحیح بین ۱ تا ${MAX_GIFT_PRICE} باشه.`, { reply_markup: cancelKeyboard() }));
      const pick = flow.data?.pick as Pick | undefined;
      if (!pick) return void (await setAdminFlow(ctx.from!.id, null));
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "pattern", data: { pick, name: flow.data?.name, price: num } });
      await ctx.reply(`اموجی پس‌زمینه‌ی هدیه؟ (الگویی که پشت هدیه تکرار میشه — یک اموجی بفرست، یا «رد» تا همون ${pick.emoji} باشه)`, { reply_markup: cancelKeyboard() });
      return;
    }

    if (flow.stage === "pattern") {
      const pick = flow.data?.pick as Pick | undefined;
      if (!pick) return void (await setAdminFlow(ctx.from!.id, null));
      const pat = text === "رد" ? undefined : (cleanGlyph(text) ?? null);
      if (pat === null) return void (await ctx.reply("یک اموجی بفرست یا «رد».", { reply_markup: cancelKeyboard() }));
      const num = Number(flow.data?.price);
      const g = await addCustomGift({ name: String(flow.data?.name ?? ""), emoji: pick.emoji, price: num, sticker: { fileId: pick.fileId, uniqueId: pick.uniqueId, format: pick.format }, starCount: pick.stars, createdBy: ctx.from!.id, ...(pat ? { pattern: pat } : {}) });
      await logAdminAction(ctx.from!.id, "navagram_gift_add", `${g._id}:${num}`);
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply(`✅ هدیه‌ی «${escapeHtml(g.name)}» اضافه شد و همین الان توی لیست هدیه‌های نوا گرام هست.\nاز «هدیه‌ها» می‌تونی یکتاش کنی یا قیمتش رو عوض کنی.`, { parse_mode: "HTML", reply_markup: inlineKeyboard([[glassButton("🎁 رفتن به هدیه‌ها", BACK_GIFTS, "primary")]]) });
      return;
    }

    if (flow.stage === "userRef") {
      if (!isOwner(ctx)) return void (await setAdminFlow(ctx.from!.id, null));
      const db = await getDb();
      const users = db.collection<any>("users");
      let u: any = null;
      if (/^\d+$/.test(faDigits(text))) u = await users.findOne({ _id: Number(faDigits(text)) });
      else if (/^user_[A-Za-z0-9]+$/.test(text)) u = await users.findOne({ anonId: text });
      else if (/^@?[A-Za-z0-9_.]{3,32}$/.test(text)) {
        const name = text.replace(/^@/, "");
        u = (await users.findOne({ miniUsernameLower: name.toLowerCase() })) ?? (await users.findOne({ username: name }));
      }
      if (!u) return void (await ctx.reply("کاربری با این مشخصات پیدا نشد. دوباره بفرست یا «لغو».", { reply_markup: cancelKeyboard() }));
      await setAdminFlow(ctx.from!.id, null);
      const v = await userGiftsView(u._id);
      await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.reply_markup });
      return;
    }

    if (flow.stage === "evPrice") {
      if (!Number.isInteger(num) || num < 1 || num > MAX_GIFT_PRICE) return void (await ctx.reply(`قیمت شروع باید یه عدد صحیح بین ۱ تا ${MAX_GIFT_PRICE} باشه.`, { reply_markup: cancelKeyboard() }));
      await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "evHours", data: { ...flow.data, startPrice: num } });
      await ctx.reply(`حراج تا چند ساعت دیگه تموم بشه؟ (۱ تا ${MAX_EVENT_HOURS})`, { reply_markup: cancelKeyboard() });
      return;
    }

    if (flow.stage === "evHours") {
      if (!Number.isFinite(num) || num < 1 || num > MAX_EVENT_HOURS) return void (await ctx.reply(`مدت باید بین ۱ تا ${MAX_EVENT_HOURS} ساعت باشه.`, { reply_markup: cancelKeyboard() }));
      if (!isOwner(ctx)) return void (await setAdminFlow(ctx.from!.id, null));
      if (flow.data?.kind === "g") {
        const card = (await giftCatalog(true)).find((c) => c.id === String(flow.data?.giftId));
        if (card && !card.unique) {
          await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "evWinners", data: { ...flow.data, hours: num } });
          await ctx.reply(`چند نفر برنده بشن؟ (۱ تا ${MAX_WINNERS})\n<i>هر برنده یک نسخه از هدیه می‌گیره.</i>`, { parse_mode: "HTML", reply_markup: cancelKeyboard() });
          return;
        }
      }
      return void (await finishEvent(ctx, flow.data, num, 1));
    }

    if (flow.stage === "evWinners") {
      if (!Number.isInteger(num) || num < 1 || num > MAX_WINNERS) return void (await ctx.reply(`تعداد برنده باید یه عدد صحیح بین ۱ تا ${MAX_WINNERS} باشه.`, { reply_markup: cancelKeyboard() }));
      if (!isOwner(ctx)) return void (await setAdminFlow(ctx.from!.id, null));
      return void (await finishEvent(ctx, flow.data, Number(flow.data?.hours), num));
    }
    return next();
  });

  async function finishEvent(ctx: any, data: any, hours: number, winners: number): Promise<void> {
    {
      const s = await getMiniSettings();
      if (!s.eventsChannelId) return void (await ctx.reply("کانال حراج و قرعه‌کشی تنظیم نشده."));
      const kind = data?.kind === "a" ? "auction" : "giveaway";
      const r = await createGiftEvent(ctx.api, { kind, giftId: String(data?.giftId), ownerId: ctx.from!.id, channelId: s.eventsChannelId, startPrice: data?.startPrice as number | undefined, hours, winners });
      await setAdminFlow(ctx.from!.id, null);
      if (r.status !== "ok") {
        const why = r.status === "sold_out" ? "این هدیه یکتاست و قبلاً به کسی داده شده (اگه می‌خوای ازش استفاده کنی، اول از «هدیه‌های یک کاربر» برای خودت بردارش)." : r.status === "channel_failed" ? "نتونستم توی کانال پست بذارم؛ مطمئن شو ربات اونجا ادمینه." : "ورودی نامعتبر بود.";
        return void (await ctx.reply(`❌ ${why}`));
      }
      await logAdminAction(ctx.from!.id, "gift_event_create", `${r.event._id}:${kind}:${r.event.giftId}`);
      await ctx.reply(`✅ ${kind === "auction" ? "حراج" : "قرعه‌کشی"} توی کانال منتشر شد.`);
    }
  }
}

export { getGiftEvent };
