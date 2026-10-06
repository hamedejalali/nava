import { InlineKeyboard, type Bot, type Context } from "grammy";
import { env } from "../config/env.js";
import { getDb } from "../db/connect.js";
import type { UserDoc } from "../db/models/user.js";
import { type WalletTexts, WalletError, accounts, addSupply, getSettings, getSupply, ledgerCol, setSupplyCap, updateSettings } from "../db/models/walletCore.js";
import { createPartner, getPartner, listPartners, retryPendingDeliveries, rotatePartnerKeys, setPartnerActive, setPartnerFee } from "../db/models/walletPartners.js";
import { createTask, deleteTask, listAllTasks, setTaskActive, type TaskType } from "../db/models/walletTasks.js";
import { trackByCode } from "../db/models/walletTrack.js";
import { formatTx } from "../services/walletTxLog.js";
import { notifyTx } from "../services/walletNotify.js";
import { deliverToPartner, refundPartnerTransfer } from "../db/models/walletPartners.js";
import { clearState, getState, setState } from "../db/models/walletBotState.js";

/** Wallet admin = OWNER_ID, ADMIN_IDS, or a Nava user the owner flagged isAdmin. */
export async function isWalletAdmin(userId: number): Promise<boolean> {
  if (env.OWNER_ID === userId || env.ADMIN_IDS.includes(userId)) return true;
  const u = await (await getDb()).collection<UserDoc>("users").findOne({ _id: userId }, { projection: { isAdmin: 1, banned: 1 } });
  return !!u && u.isAdmin === true && !u.banned;
}

export const ADMIN_BUTTON = "⚙️ تنظیمات ولت";
const L = {
  stats: "📊 آمار و موجودی کل", topup: "💎 شارژ موجودی کل", bonus: "🎁 پاداش ثبت‌نام", fees: "💸 کارمزدها", limits: "💱 نرخ و محدودیت‌ها",
  txch: "📣 کانال تراکنش‌ها", revch: "📝 کانال بررسی تسک‌ها", tasks: "✅ تسک‌ها", partners: "🔌 پارتنرها", texts: "🧾 متن‌ها", pending: "🔁 تحویل‌های معلق", track: "🔎 پیگیری تراکنش", packs: "🛒 بسته‌های خرید", back: "🏠 بازگشت",
} as const;

const LABELS = new Set<string>([...Object.values(L), ADMIN_BUTTON, "💰 موجودی", "📤 ارسال", "📥 دریافت", "🛒 خرید رلیک"]);
const TEXT_KEYS: Record<string, string> = { welcome: "پیام شروع", receive: "توضیح دریافت", sendIntro: "متن ارسال", balance: "عنوان موجودی", buy: "متن پرداخت خرید" };
const TYPE_FA: Record<string, string> = { channel: "جوین کانال (بررسی خودکار)", bot: "استارت ربات", link: "لینک", instagram: "اینستاگرام", other: "سایر" };
const esc = (t: string) => t.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const toNum = (t: string) => Number(t.trim().replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[,٬\s]/g, ""));

export function registerWalletAdmin(bot: Bot<Context>) {
  const guard = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from || ctx.chat?.type !== "private") return false;
    return isWalletAdmin(ctx.from.id);
  };
  const ask = async (ctx: Context, step: string, prompt: string, data: Record<string, any> = {}) => {
    await setState(ctx.from!.id, step, data);
    await ctx.reply(prompt);
  };

  // Every admin section is reachable both from the inline hub (below) and by its old keyboard label.
  const sec = (label: string, key: string, fn: (ctx: Context) => Promise<void>) => {
    bot.hears(label, fn);
    bot.callbackQuery(`wa:m:${key}`, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await fn(ctx);
    });
  };

  const hub = () => {
    const kb = new InlineKeyboard()
      .text(L.stats, "wa:m:stats").text(L.topup, "wa:m:topup").row()
      .text(L.bonus, "wa:m:bonus").text(L.fees, "wa:m:fees").text(L.limits, "wa:m:limits").row()
      .text(L.txch, "wa:m:txch").text(L.revch, "wa:m:revch").row()
      .text(L.tasks, "wa:m:tasks").text(L.packs, "wa:m:packs").text(L.texts, "wa:m:texts").row()
      .text(L.partners, "wa:m:partners").text(L.pending, "wa:m:pending").row()
      .text(L.track, "wa:m:track").row()
      .text("✖️ بستن", "wa:close");
    const text =
      "⚙️ پنل مدیریت ولت\n\n" +
      "📊 آمار و موجودی: وضعیت کل رلیک، شارژ یا تغییر سقف\n" +
      "🎁 پاداش / 💸 کارمزد / 💱 نرخ: مقدارهای ولت\n" +
      "📣 کانال تراکنش‌ها: هر تراکنش آنجا گزارش می‌شود\n" +
      "📝 کانال بررسی: درخواست تسک دستی (اگر خالی باشد به PV شما می‌آید)\n" +
      "✅ تسک‌ها: ساخت و مدیریت تسک‌ها\n" +
      "🛒 دکمه‌های خرید: دکمه‌های شیشه‌ای خرید رلیک (نام، لینک، مقدار)\n" +
      "🧾 متن‌ها: متن‌های ربات\n" +
      "🔌 پارتنرها: ربات‌های متصل و کلید API (شامل API تایید خرید)\n" +
      "🔁 تحویل‌های معلق: انتقال‌های در انتظار پارتنر\n" +
      "🔎 پیگیری تراکنش: با کد TX-… ببین چه شده";
    return { text, kb };
  };
  bot.hears(ADMIN_BUTTON, async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const h = hub();
    await ctx.reply(h.text, { reply_markup: h.kb });
  });
  bot.callbackQuery("wa:close", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  });

  // ------------------------------------------------------------ stats
  sec(L.stats, "stats", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const [s, st, n, ledPend, claimsPend] = await Promise.all([
      getSupply(), getSettings(), (await accounts()).countDocuments({}),
      (await ledgerCol()).countDocuments({ kind: "to_partner", status: "pending" }),
      (await getDb()).collection("wallet_task_claims").countDocuments({ status: "pending" }),
    ]);
    const bal = (await (await accounts()).find({}).toArray()).reduce((a, x) => a + x.balance, 0);
    const partnerFloat = (await listPartners()).reduce((a, p) => a + p.balance, 0);
    await ctx.reply(
      `📊 آمار ولت\n\nسقف کل رلیک: ${s.cap.toLocaleString("fa-IR")}\nباقی‌مانده برای پخش: ${s.remaining.toLocaleString("fa-IR")}\nتاکنون پخش‌شده: ${s.issued.toLocaleString("fa-IR")}\n` +
        `مجموع موجودی ولت‌ها: ${bal.toLocaleString("fa-IR")}\nمنتقل‌شده به ربات‌های دیگر (پارتنرها): ${partnerFloat.toLocaleString("fa-IR")}\nکارمزد جمع‌شده: ${s.feesCollected.toLocaleString("fa-IR")}\n\n` +
        `تعداد ولت‌ها: ${n}\nتحویل معلق: ${ledPend}\nتسک در انتظار بررسی: ${claimsPend}\nپاداش ثبت‌نام: ${st.signupBonus}\nکانال تراکنش: ${st.txLogChatId ?? "تنظیم نشده"}\nکانال بررسی تسک: ${st.taskReviewChatId ?? "تنظیم نشده"}`,
    );
  });

  // ------------------------------------------------------------ supply
  sec(L.topup, "topup", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const s = await getSupply();
    await ctx.reply(`💎 موجودی کل رلیک\nسقف: ${s.cap.toLocaleString("fa-IR")} | باقی‌مانده: ${s.remaining.toLocaleString("fa-IR")}`, {
      reply_markup: new InlineKeyboard().text("➕ افزودن به موجودی", "wa:supply:add").text("🎯 تنظیم سقف کل", "wa:supply:cap"),
    });
  });
  bot.callbackQuery(/^wa:supply:(add|cap)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, ctx.match[1] === "add" ? "a_supply_add" : "a_supply_cap", ctx.match[1] === "add" ? "چه مقدار رلیک به موجودی کل اضافه شود؟ (عدد)" : "سقف جدید کل رلیک چقدر باشد؟ (نمی‌تواند کمتر از مقدار پخش‌شده باشد)");
  });

  sec(L.bonus, "bonus", async (ctx) => {
    if (!(await guard(ctx))) return;
    const s = await getSettings();
    await ask(ctx, "a_bonus", `پاداش ثبت‌نام فعلی: ${s.signupBonus} رلیک.\nمقدار جدید (۰ = غیرفعال):`);
  });

  // ------------------------------------------------------------ fees / limits
  sec(L.fees, "fees", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const [s, partners] = await Promise.all([getSettings(), listPartners()]);
    const fmt = (r: { pct: number; fixed: number }) => `${r.pct}٪ + ${r.fixed}`;
    const kb = new InlineKeyboard().text(`ولت↔ولت (${fmt(s.feeWallet)})`, "wa:fee:wallet").row().text(`ولت→نوا (${fmt(s.feeNava)})`, "wa:fee:nava");
    for (const p of partners) kb.row().text(`${p.name} (${fmt(p.fee)})`, `wa:fee:p:${p._id}`);
    await ctx.reply("💸 کارمزد انتقال (روی فرستنده، علاوه بر مبلغ). کدام را تغییر می‌دهی؟", { reply_markup: kb });
  });
  bot.callbackQuery(/^wa:fee:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, "a_fee", "کارمزد را به شکل «درصد ثابت» بفرست. مثال: «2 1» یعنی ۲٪ + ۱ رلیک ثابت. برای بدون کارمزد: «0 0»", { target: ctx.match[1] });
  });

  sec(L.limits, "limits", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const s = await getSettings();
    await ctx.reply(`💱 نرخ و محدودیت‌ها\nحداقل انتقال: ${s.transferMin}\nحداکثر انتقال: ${s.transferMax}\nنرخ هر رلیک: ${s.tomanRate} تومان`, {
      reply_markup: new InlineKeyboard().text("حداقل انتقال", "wa:lim:transferMin").text("حداکثر انتقال", "wa:lim:transferMax").row().text("نرخ تومان", "wa:lim:tomanRate"),
    });
  });
  bot.callbackQuery(/^wa:lim:(transferMin|transferMax|tomanRate)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, "a_limit", "مقدار جدید را بفرست (عدد):", { field: ctx.match[1] });
  });

  // ------------------------------------------------------------ channels
  sec(L.txch, "txch", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ask(ctx, "a_txch", "📣 ربات را ادمین کانال «تراکنش‌ها» کن، بعد یک پیام از آن کانال اینجا فوروارد کن (یا آیدی عددی کانال مثل -100123… را بفرست).");
  });
  sec(L.revch, "revch", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ask(ctx, "a_revch", "📝 ربات را ادمین کانال «بررسی تسک‌ها» کن، بعد یک پیام از آن کانال فوروارد کن (یا آیدی عددی کانال را بفرست). عکس/درخواست‌های بررسی با دکمه تایید/رد آنجا می‌آید.");
  });

  // ------------------------------------------------------------ tasks
  const taskList = async (ctx: Context) => {
    const tasks = await listAllTasks();
    if (!tasks.length) await ctx.reply("هنوز تسکی ثبت نشده.");
    for (const t of tasks) {
      await ctx.reply(
        `${t.active ? "🟢" : "⚪️"} ${t.title}\nنوع: ${TYPE_FA[t.type]}${t.chatRef ? ` (${t.chatRef})` : ""}\nجایزه: ${t.reward}${t.gate ? `\n🔒 قفل ماین بعد از ${t.afterTaps} ضربه` : ""}\nشناسه: ${t._id}`,
        { reply_markup: new InlineKeyboard().text(t.active ? "⏸ غیرفعال" : "▶️ فعال", `wa:t:toggle:${t._id}`).text("🗑 حذف", `wa:t:del:${t._id}`) },
      );
    }
    await ctx.reply("—", { reply_markup: new InlineKeyboard().text("➕ تسک جدید", "wa:t:new") });
  };
  sec(L.tasks, "tasks", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    await taskList(ctx);
  });
  bot.callbackQuery(/^wa:t:(toggle|del):(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    const id = ctx.match[2]!;
    if (ctx.match[1] === "del") { await deleteTask(id); await ctx.answerCallbackQuery({ text: "حذف شد" }); await ctx.editMessageText("🗑 حذف شد").catch(() => {}); return; }
    const t = (await listAllTasks()).find((x) => x._id === id);
    if (t) await setTaskActive(id, !t.active);
    await ctx.answerCallbackQuery({ text: t?.active ? "غیرفعال شد" : "فعال شد" });
  });
  bot.callbackQuery("wa:t:new", async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, "a_t_title", "عنوان تسک را بفرست (مثلاً «عضویت در کانال ما»):", {});
  });
  bot.callbackQuery(/^wa:t:type:(channel|bot|link|instagram|other)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const st = await getState(ctx.from.id);
    if (!st) return;
    await ask(ctx, "a_t_url", "لینک تسک را بفرست (برای کانال: https://t.me/...). اگر لینک ندارد «-» بفرست:", { ...st.data, type: ctx.match[1] });
  });
  bot.callbackQuery(/^wa:t:gate:(yes|no)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const st = await getState(ctx.from.id);
    if (!st) return;
    if (ctx.match[1] === "yes") return void (await ask(ctx, "a_t_after", "بعد از چند ضربهٔ ماین این تسک اجباری شود؟ (مثلاً 5)", { ...st.data, gate: true }));
    await finishTask(ctx, { ...st.data, gate: false });
  });
  const finishTask = async (ctx: Context, d: Record<string, any>) => {
    const t = await createTask({ title: d.title, description: d.description, type: d.type as TaskType, url: d.url, chatRef: d.chatRef, reward: d.reward, gate: d.gate, afterTaps: d.afterTaps });
    await clearState(ctx.from!.id);
    await ctx.reply(`✅ تسک ساخته شد (${t._id}).${t.type === "channel" && t.chatRef ? "\nبرای بررسی خودکار، ربات باید ادمین آن کانال باشد." : t.type !== "channel" ? "\nاین نوع تسک توسط شما در کانال بررسی تایید/رد می‌شود." : ""}`);
  };

  // ------------------------------------------------------------ partners
  sec(L.partners, "partners", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const ps = await listPartners();
    for (const p of ps) {
      await ctx.reply(`${p.active ? "🟢" : "⚪️"} ${p.name} (${p._id})\n${p.baseUrl}\nموجودی منتقل‌شده به آن: ${p.balance}\nمجوز شارژ از موجودی کل: ${p.canIssue ? "بله" : "خیر"}`, {
        reply_markup: new InlineKeyboard().text(p.active ? "⏸ غیرفعال" : "▶️ فعال", `wa:p:toggle:${p._id}`).text("🔑 کلید جدید", `wa:p:rotate:${p._id}`),
      });
    }
    await ctx.reply("—", { reply_markup: new InlineKeyboard().text("➕ پارتنر جدید", "wa:p:new") });
  });
  bot.callbackQuery("wa:p:new", async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, "a_p_id", "شناسه کوتاه انگلیسی پارتنر (مثل dl):");
  });
  bot.callbackQuery(/^wa:p:(toggle|rotate):(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const p = await getPartner(ctx.match[2]!);
    if (!p) return;
    if (ctx.match[1] === "toggle") { await setPartnerActive(p._id, !p.active); await ctx.reply(p.active ? "غیرفعال شد." : "فعال شد."); return; }
    const k = await rotatePartnerKeys(p._id);
    await ctx.reply(`🔑 کلیدهای جدید ${esc(p.name)} (فقط همین یک‌بار نمایش داده می‌شود؛ قبلی‌ها باطل شد):\n\nAPI Key:\n<code>${k.apiKey}</code>\n\nWebhook Secret:\n<code>${k.webhookSecret}</code>`, { parse_mode: "HTML" });
  });
  bot.callbackQuery(/^wa:p:issue:(yes|no)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const st = await getState(ctx.from.id);
    if (!st || st.step !== "a_p_issue") return;
    try {
      const k = await createPartner({ id: st.data.id, name: st.data.name, baseUrl: st.data.baseUrl, canIssue: ctx.match[1] === "yes" });
      await clearState(ctx.from.id);
      await ctx.reply(`✅ پارتنر ساخته شد.\n\nاین دو مقدار را فقط برای توسعه‌دهندهٔ ربات مقصد بفرست (دیگر نمایش داده نمی‌شود):\n\nشناسه: <code>${esc(k.id)}</code>\nAPI Key:\n<code>${k.apiKey}</code>\nWebhook Secret:\n<code>${k.webhookSecret}</code>\n\nآدرس API ولت: <code>${esc((process.env.PUBLIC_URL ?? "https://<NAVA_DOMAIN>").replace(/\/+$/, ""))}/api/wallet/transfer</code>`, { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`⚠️ ${err instanceof WalletError ? err.code : "خطا"}`);
    }
  });

  // ------------------------------------------------------------ texts
  sec(L.texts, "texts", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const kb = new InlineKeyboard();
    Object.entries(TEXT_KEYS).forEach(([k, label], i) => { if (i % 2 === 0) kb.row(); kb.text(label, `wa:txt:${k}`); });
    await ctx.reply("🧾 کدام متن را ویرایش می‌کنی؟", { reply_markup: kb });
  });
  bot.callbackQuery(/^wa:txt:(welcome|receive|sendIntro|balance|buy)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const { DEFAULT_TEXTS } = await import("../walletBot.js");
    const key = ctx.match[1] as string;
    const cur = (await getSettings()).texts[key as keyof WalletTexts] ?? (DEFAULT_TEXTS as any)[key] ?? "(تنظیم نشده)";
    await ask(ctx, "a_text", `متن فعلی:\n\n${cur}\n\nمتن جدید را بفرست («-» = بازگشت به پیش‌فرض):`, { key });
  });


  // ------------------------------------------------------------ purchase buttons (glass buttons in the wallet bot)
  sec(L.packs, "packs", async (ctx) => {
    if (!(await guard(ctx))) return;
    await clearState(ctx.from!.id);
    const s = await getSettings();
    const pk = s.packages ?? [];
    const lines = pk.map((p, i) => `${i + 1}. ${p.title}\n   +${p.relic} رلیک | شناسه: ${p.id}\n   ${p.url}`).join("\n\n");
    const kb = new InlineKeyboard();
    pk.forEach((p, i) => kb.row().text(`🗑 حذف: ${p.title}`.slice(0, 60), `wa:pk:del:${i}`));
    kb.row().text("➕ دکمه خرید جدید", "wa:pk:new");
    await ctx.reply(
      `🛒 دکمه‌های خرید رلیک (${pk.length})\n\n${lines || "هنوز دکمه‌ای نساخته‌ای."}\n\n` +
        "کاربر با زدن «🛒 خرید رلیک» این دکمه‌ها را می‌بیند. بعد از پرداخت، سایت/ربات پرداخت تو باید با API ولت (پارتنر با مجوز «شارژ») اعلام کند:\n" +
        "action=credit, token (یا userId), packageId, externalId\nمستندات: docs/PARTNER_API.md",
      { reply_markup: kb },
    );
  });
  bot.callbackQuery("wa:pk:new", async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await ask(ctx, "a_pk_title", "نام روی دکمه چه باشد؟ مثال: «۵۰ رلیک ۱۰۰ هزار تومان»");
  });
  bot.callbackQuery(/^wa:pk:del:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    const s = await getSettings();
    const pk = [...(s.packages ?? [])];
    pk.splice(Number(ctx.match[1]), 1);
    await updateSettings({ packages: pk });
    await ctx.answerCallbackQuery({ text: "حذف شد" });
    await ctx.editMessageText("🗑 دکمه حذف شد.").catch(() => {});
  });

  // ------------------------------------------------------------ tracking-code lookup
  sec(L.track, "track", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ask(ctx, "a_track", "🔎 کد پیگیری را بفرست (مثل TX-7K3M9QX2):");
  });
  const showTrack = async (ctx: Context, input: string) => {
    const { row, related } = await trackByCode(input);
    const extra = [`شناسه داخلی: ${row._id}`, `کد: ${row.code}`];
    if (row.attempts !== undefined) extra.push(`تلاش‌های تحویل: ${row.attempts}`);
    if (row.lastError) extra.push(`آخرین خطا: ${row.lastError}`);
    if (row.completedAt) extra.push(`پایان: ${row.completedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`);
    if (row.notified) extra.push(`آخرین وضعیت اطلاع‌داده‌شده به طرفین: ${row.notified}`);
    for (const r of related) extra.push(`↳ مرتبط: ${r.kind} ${r.amount} رلیک [${r.status}] کد ${r.code ?? "-"}`);
    const kb = new InlineKeyboard();
    if (row.kind === "to_partner" && row.status === "pending") kb.text("🔁 تلاش مجدد تحویل", `wa:trk:retry:${row._id}`).row().text("↩️ بازگشت وجه به فرستنده", `wa:trk:refund:${row._id}`);
    await ctx.reply(`${formatTx(row)}\n\n${extra.join("\n")}`, kb.inline_keyboard.length ? { reply_markup: kb } : {});
  };
  bot.callbackQuery(/^wa:trk:(retry|refund):(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const id = ctx.match[2]!;
    const r = ctx.match[1] === "retry" ? await deliverToPartner(id) : await refundPartnerTransfer(id, "manual_by_admin");
    await ctx.reply(`نتیجه: ${r}`);
  });

  // ------------------------------------------------------------ pending deliveries
  sec(L.pending, "pending", async (ctx) => {
    if (!(await guard(ctx))) return;
    const rows = await (await ledgerCol()).find({ kind: "to_partner", status: "pending" }).sort({ createdAt: 1 }).limit(20).toArray();
    if (!rows.length) return void (await ctx.reply("✅ هیچ تحویل معلقی نیست."));
    await ctx.reply(rows.map((r) => `• ${r.amount} رلیک → ${r.toName ?? r.to} | تلاش: ${r.attempts ?? 0}${r.lastError ? ` | ${r.lastError}` : ""}\n  ${r._id}`).join("\n"), {
      reply_markup: new InlineKeyboard().text("🔁 تلاش مجدد همه", "wa:retry"),
    });
  });
  bot.callbackQuery("wa:retry", async (ctx) => {
    if (!(await guard(ctx))) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    const r = await retryPendingDeliveries(50);
    await ctx.reply(`تلاش شد: ${r.tried} | تحویل شد: ${r.completed} | برگشت خورد: ${r.refunded}`);
  });

  // ------------------------------------------------------------ message input for all admin steps
  const channelFrom = (ctx: Context): number | null => {
    const m: any = ctx.message;
    if (m?.forward_origin?.type === "channel") return m.forward_origin.chat.id;
    if (m?.forward_from_chat?.id) return m.forward_from_chat.id;
    const t = typeof m?.text === "string" ? m.text.trim() : "";
    return /^-?\d{5,}$/.test(t) ? Number(t) : null;
  };

  bot.on("message", async (ctx, next) => {
    if (!ctx.from || ctx.chat.type !== "private") return next();
    const st = await getState(ctx.from.id);
    if (!st || !st.step.startsWith("a_")) return next();
    if (!(await isWalletAdmin(ctx.from.id))) { await clearState(ctx.from.id); return next(); }
    const text = ctx.message.text?.trim() ?? "";
    if (text.startsWith("/") || LABELS.has(text)) { await clearState(ctx.from.id); return next(); } // a menu button/command cancels the running flow
    const num = toNum(text);
    const bad = (msg = "ورودی نامعتبر است؛ دوباره بفرست (یا از منو خارج شو).") => ctx.reply(`⚠️ ${msg}`);

    try {
      switch (st.step) {
        case "a_supply_add": {
          if (!Number.isInteger(num) || num <= 0) return void (await bad("یک عدد صحیح مثبت بفرست."));
          const s = await addSupply(num);
          await clearState(ctx.from.id);
          return void (await ctx.reply(`✅ اضافه شد. سقف: ${s.cap.toLocaleString("fa-IR")} | باقی‌مانده: ${s.remaining.toLocaleString("fa-IR")}`));
        }
        case "a_supply_cap": {
          if (!Number.isInteger(num) || num <= 0) return void (await bad("یک عدد صحیح مثبت بفرست."));
          const s = await setSupplyCap(num);
          await clearState(ctx.from.id);
          return void (await ctx.reply(`✅ سقف جدید: ${s.cap.toLocaleString("fa-IR")} | باقی‌مانده: ${s.remaining.toLocaleString("fa-IR")}`));
        }
        case "a_bonus": {
          if (!Number.isInteger(num) || num < 0 || num > 1_000_000) return void (await bad());
          await updateSettings({ signupBonus: num });
          await clearState(ctx.from.id);
          return void (await ctx.reply(`✅ پاداش ثبت‌نام: ${num} رلیک`));
        }
        case "a_fee": {
          const [pctS, fixedS] = text.split(/\s+/);
          const pct = toNum(pctS ?? ""), fixed = toNum(fixedS ?? "0");
          if (!Number.isFinite(pct) || pct < 0 || pct > 50 || !Number.isInteger(fixed) || fixed < 0 || fixed > 1_000_000) return void (await bad("فرمت: «درصد ثابت» مثل 2 1 (درصد حداکثر ۵۰)."));
          const target = st.data.target as string;
          if (target === "wallet") await updateSettings({ feeWallet: { pct, fixed } });
          else if (target === "nava") await updateSettings({ feeNava: { pct, fixed } });
          else await setPartnerFee(target.replace(/^p:/, ""), { pct, fixed });
          await clearState(ctx.from.id);
          return void (await ctx.reply(`✅ کارمزد: ${pct}٪ + ${fixed}`));
        }
        case "a_limit": {
          const f = st.data.field as string;
          if (!Number.isFinite(num) || num <= 0 || (f !== "tomanRate" && !Number.isInteger(num))) return void (await bad());
          await updateSettings({ [f]: num });
          await clearState(ctx.from.id);
          return void (await ctx.reply("✅ ذخیره شد."));
        }
        case "a_txch":
        case "a_revch": {
          const id = channelFrom(ctx);
          if (id === null) return void (await bad("یک پیام از کانال فوروارد کن یا آیدی عددی بفرست."));
          try { await ctx.api.sendMessage(id, "✅ اتصال ولت به این چت برقرار شد."); }
          catch { return void (await bad("ربات نمی‌تواند در آن چت پیام بفرستد؛ ابتدا ربات را ادمین کن.")); }
          if (st.step === "a_txch") await updateSettings({ txLogChatId: id, txLogSince: new Date() });
          else await updateSettings({ taskReviewChatId: id });
          await clearState(ctx.from.id);
          return void (await ctx.reply("✅ ذخیره شد."));
        }
        case "a_text": {
          const s = await getSettings();
          const texts = { ...s.texts };
          if (text === "-") delete (texts as any)[st.data.key]; else (texts as any)[st.data.key] = text.slice(0, 1500);
          await updateSettings({ texts });
          await clearState(ctx.from.id);
          return void (await ctx.reply("✅ ذخیره شد."));
        }
        case "a_track": {
          await clearState(ctx.from.id);
          return void (await showTrack(ctx, text));
        }
        case "a_pk_title":
          if (!text || text.length > 60) return void (await bad("نام دکمه تا ۶۰ کاراکتر."));
          return void (await ask(ctx, "a_pk_url", "لینک پرداخت را بفرست (https://...). می‌توانی {uid} (آیدی عددی کاربر) و {token} (توکن ولت کاربر) را داخل لینک بگذاری.", { title: text }));
        case "a_pk_url":
          if (!/^https:\/\/\S+$/.test(text) || text.length > 500) return void (await bad("لینک باید با https:// شروع شود."));
          return void (await ask(ctx, "a_pk_relic", "برای این دکمه چند رلیک به کاربر اضافه شود؟ (مثلاً 50)", { ...st.data, url: text }));
        case "a_pk_relic": {
          if (!Number.isInteger(num) || num <= 0 || num > 100_000_000) return void (await bad("یک عدد صحیح مثبت بفرست."));
          const s = await getSettings();
          const pk = [...(s.packages ?? [])];
          if (pk.length >= 10) return void (await bad("حداکثر ۱۰ دکمه."));
          const id = `pk_${Math.random().toString(36).slice(2, 8)}`;
          pk.push({ id, title: st.data.title, url: st.data.url, relic: num });
          await updateSettings({ packages: pk });
          await clearState(ctx.from.id);
          return void (await ctx.reply(`✅ دکمه ساخته شد.\nشناسه برای API تایید خرید: ${id}\n(+${num} رلیک)`));
        }
        case "a_t_title":
          if (!text) return void (await bad());
          return void (await ask(ctx, "a_t_desc", "توضیح کوتاه تسک («-» برای بدون توضیح):", { title: text.slice(0, 80) }));
        case "a_t_desc":
          return void (await (async () => {
            await setState(ctx.from.id, "a_t_type", { ...st.data, description: text === "-" ? "" : text });
            const kb = new InlineKeyboard();
            Object.entries(TYPE_FA).forEach(([k, v]) => kb.row().text(v, `wa:t:type:${k}`));
            await ctx.reply("نوع تسک:", { reply_markup: kb });
          })());
        case "a_t_url": {
          const url = text === "-" ? null : text;
          if (url && !/^https?:\/\//.test(url)) return void (await bad("لینک باید با https:// شروع شود یا «-» بفرست."));
          if (st.data.type === "channel") return void (await ask(ctx, "a_t_chat", "آیدی کانال برای بررسی خودکار عضویت را بفرست (مثل @mychannel یا -100123…). ربات باید ادمین آن کانال باشد:", { ...st.data, url }));
          return void (await ask(ctx, "a_t_reward", "جایزه این تسک چند رلیک باشد؟", { ...st.data, url, chatRef: null }));
        }
        case "a_t_chat": {
          const fwd = channelFrom(ctx);
          const ref = /^@[A-Za-z0-9_]{4,}$/.test(text) ? text : fwd !== null ? String(fwd) : null;
          if (!ref) return void (await bad("آیدی کانال مثل @mychannel یا -100123456789 بفرست، یا یک پیام از کانال فوروارد کن."));
          return void (await ask(ctx, "a_t_reward", "جایزه این تسک چند رلیک باشد؟", { ...st.data, chatRef: ref }));
        }
        case "a_t_reward": {
          if (!Number.isInteger(num) || num < 0) return void (await bad());
          await setState(ctx.from.id, "a_t_gate", { ...st.data, reward: num });
          return void (await ctx.reply("این تسک «قفل ماین» باشد؟ (یعنی کاربر بعد از چند ضربه تا انجامش نتواند ماین کند)", {
            reply_markup: new InlineKeyboard().text("🔒 بله", "wa:t:gate:yes").text("خیر", "wa:t:gate:no"),
          }));
        }
        case "a_t_after": {
          if (!Number.isInteger(num) || num < 0) return void (await bad());
          return void (await finishTask(ctx, { ...st.data, afterTaps: num }));
        }
        case "a_p_id":
          if (!/^[a-z0-9_-]{2,24}$/i.test(text)) return void (await bad("فقط انگلیسی/عدد، ۲ تا ۲۴ کاراکتر."));
          return void (await ask(ctx, "a_p_name", "نام نمایشی ربات (مثلاً «ربات دانلودر»):", { id: text }));
        case "a_p_name":
          return void (await ask(ctx, "a_p_url", "آدرس پایه API دریافت‌کننده در ربات مقصد (https://...؛ ولت به {آدرس}/resolve و {آدرس}/receive درخواست می‌زند):", { ...st.data, name: text.slice(0, 40) }));
        case "a_p_url": {
          if (!/^https:\/\//.test(text)) return void (await bad("باید https:// باشد."));
          await setState(ctx.from.id, "a_p_issue", { ...st.data, baseUrl: text });
          return void (await ctx.reply("آیا این ربات اجازه دارد «شارژ/جایزه خرید» از موجودی کل رلیک بدهد؟", {
            reply_markup: new InlineKeyboard().text("بله", "wa:p:issue:yes").text("خیر", "wa:p:issue:no"),
          }));
        }
        default:
          return next();
      }
    } catch (err) {
      await ctx.reply(`⚠️ ${err instanceof WalletError ? err.code : "خطای داخلی"}`);
    }
  });
}
