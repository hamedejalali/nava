import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { glassButton, glassReplyButton, inlineKeyboard, replyKeyboard } from "../../ui/keyboard.js";
import { ADMIN_CATEGORY_LABELS, ADMIN_MENU_LABELS } from "./menu.js";
import { getDb } from "../../db/connect.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { isOwner } from "./constants.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { createJetonJob, getJetonJob, type JetonMode } from "../../db/models/jetonJobs.js";
import { MODE_FA, countRecipients, processJetonJob, sendJetonSummaryOnce } from "../../services/jetonMass.js";

/**
 * v1.29.0 — «🪙 مدیریت ژتون» (owner): three bulk ways to send jeton, each = target → amount → message → optional 2nd message → confirm.
 * The people receive ONLY the message(s) typed here (no "charged by the owner" notice). The log channel gets one summary.
 */
const P = "admin:relic:mass:";
const FLOW = "jetonmass";
const MAX_AMOUNT = 1_000_000;
const MAX_IDS = 500;
const MAX_MSG = 3500;

interface Data {
  mode?: JetonMode;
  days?: number;
  gender?: "male" | "female";
  ids?: number[];
  amount?: number;
  messages?: string[];
}

/** v1.29.7: the options live on the panel's reply keyboard (like every other panel topic). The back button is the panel's own «↩️ بازگشت به پنل»
 *  (so the keyboard is recognised as an admin keyboard and is restored correctly after a cancelled step). */
export function jetonMenu() {
  const L = ADMIN_MENU_LABELS;
  return {
    text: "🪙 مدیریت ژتون — یکی رو انتخاب کن 👇",
    reply_markup: replyKeyboard([
      [glassReplyButton(L.jetonInactive, "primary")],
      [glassReplyButton(L.jetonGender, "primary")],
      [glassReplyButton(L.jetonUsers, "primary")],
      [glassReplyButton(L.jetonManual, "success")],
      [glassReplyButton(ADMIN_CATEGORY_LABELS.back, "danger")],
    ]),
  };
}

const who = (g?: string) => (g === "female" ? "دختر" : "پسر");
const amountPrompt = (d: Data) =>
  d.mode === "gender" ? `چند ژتون به هر ${who(d.gender)}؟ (یک عدد)` : d.mode === "inactive" ? "چند ژتون به هر نفر؟ (یک عدد)" : "چند ژتون به هر کاربر؟ (یک عدد)";

function params(d: Data) {
  return d.mode === "inactive" ? { days: d.days, cutoff: new Date(Date.now() - (d.days ?? 0) * 86_400_000) } : d.mode === "gender" ? { gender: d.gender } : { ids: d.ids };
}

async function save(adminId: number, stage: string, data: Data) {
  await setAdminFlow(adminId, { flow: FLOW, stage, data: data as Record<string, unknown> });
}

async function askMessage(ctx: NavaContext, d: Data) {
  await ctx.reply("پیامی که بعد از ارسال ژتون برای اون اشخاص فرستاده بشه رو بنویس:", {
    reply_markup: inlineKeyboard([[glassButton("🚫 بدون پیام", `${P}nomsg`, "danger")]]),
  });
}

async function askConfirm(ctx: NavaContext, d: Data) {
  const p = params(d);
  const n = await countRecipients(d.mode!, p);
  if (n === 0) {
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply("کسی با این شرایط پیدا نشد؛ چیزی ارسال نشد.");
    return;
  }
  await save(ctx.from!.id, "confirm", d);
  const msgs = d.messages ?? [];
  await ctx.reply(
    `📋 خلاصه\n\nگروه: ${MODE_FA[d.mode!]}${d.mode === "inactive" ? ` (بدون فعالیت در ${d.days} روز اخیر)` : d.mode === "gender" ? ` (${who(d.gender)}ها)` : ""}\n` +
      `تعداد: ${n} نفر\nبه ازای هر نفر: ${d.amount} ژتون\nمجموع: ${n * d.amount!} ژتون\n` +
      (msgs.length ? msgs.map((m, i) => `\nپیام ${i + 1}:\n${m}`).join("\n") : "\nبدون پیام") +
      "\n\nارسال بشه؟",
    { reply_markup: inlineKeyboard([[glassButton("✅ ارسال", `${P}confirm`, "success"), glassButton("❌ لغو", `${P}cancel`, "danger")]]) },
  );
}

async function run(ctx: NavaContext, jobId: string) {
  const job0 = await getJetonJob(jobId);
  if (!job0) return;
  await processJetonJob(ctx.api, job0);
  const job = await getJetonJob(jobId);
  if (!job) return;
  const name = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? String(ctx.from?.id));
  if (job.done) {
    await sendJetonSummaryOnce(ctx.api, jobId, name);
    await ctx.reply(`✅ تموم شد: ${job.credited} نفر × ${job.amount} ژتون = ${job.credited * job.amount} ژتون.`);
  } else {
    await ctx.reply(`📤 تا الان ${job.credited} نفر انجام شد (از حدود ${job.matched}). ادامه‌ش رو با دکمه‌ی زیر بزن؛ کران روزانه هم خودش ادامه می‌ده.`, {
      reply_markup: inlineKeyboard([[glassButton("▶️ ادامه‌ی ارسال", `${P}go:${jobId}`, "primary")]]),
    });
  }
}

async function startMode(ctx: NavaContext, act: "inactive" | "users" | "gender") {
  const id = ctx.from!.id;
  if (act === "inactive") {
    await save(id, "days", { mode: "inactive" });
    await ctx.reply("کاربرانی که چند روز اخیر فعالیت نداشتن؟ تعداد روز رو بفرست (مثلاً 7):", { reply_markup: cancelKeyboard() });
  } else if (act === "users") {
    await save(id, "ids", { mode: "users" });
    await ctx.reply("آیدی عددی کاربر یا کاربرها رو بفرست (هر کدوم تو یک خط، یا با فاصله / ویرگول جدا):", { reply_markup: cancelKeyboard() });
  } else {
    await save(id, "gender", { mode: "gender" });
    // a list of choices → glass inline buttons; the red cancel stays on the reply keyboard (it is not replaced by this inline message)
    await ctx.reply("برای کدوم جنسیت؟", { reply_markup: inlineKeyboard([[glassButton("👧 دختر", `${P}g:female`, "danger"), glassButton("👦 پسر", `${P}g:male`, "primary")], [glassButton("❌ لغو", `${P}cancel`, "danger")]]) });
  }
}

export function registerAdminJeton(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${P}(inactive|users|gender|nomsg|add2|skip2|confirm|cancel)$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    const id = ctx.from!.id;
    const act = ctx.match![1]!;
    if (act === "cancel") {
      await setAdminFlow(id, null);
      await ctx.editMessageText("لغو شد.").catch(() => {});
      return;
    }
    if (act === "inactive" || act === "users" || act === "gender") return void (await startMode(ctx, act));
    const flow = await getAdminFlow(id);
    if (!flow || flow.flow !== FLOW) return void (await ctx.reply("این مرحله دیگه فعال نیست؛ از «🪙 مدیریت ژتون» دوباره شروع کن."));
    const d = (flow.data ?? {}) as Data;
    if (act === "nomsg" && flow.stage === "msg1") {
      d.messages = [];
      await askConfirm(ctx, d);
    } else if (act === "add2" && flow.stage === "ask2") {
      await save(id, "msg2", d);
      await ctx.reply("متن پیام دوم رو بنویس (بعد از پیام اول فرستاده میشه):", { reply_markup: cancelKeyboard() });
    } else if (act === "skip2" && flow.stage === "ask2") {
      await askConfirm(ctx, d);
    } else if (act === "confirm" && flow.stage === "confirm") {
      await setAdminFlow(id, null); // a double tap can never start two jobs
      const matched = await countRecipients(d.mode!, params(d));
      const job = await createJetonJob({ createdBy: id, mode: d.mode!, params: params(d), amount: d.amount!, messages: d.messages ?? [], matched });
      await ctx.editMessageText("⏳ ارسال شروع شد…").catch(() => {});
      await run(ctx, job._id);
    }
  });

  composer.callbackQuery(new RegExp(`^${P}g:(male|female)$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW || flow.stage !== "gender") return;
    const d: Data = { mode: "gender", gender: ctx.match![1] as "male" | "female" };
    await save(ctx.from!.id, "amount", d);
    await ctx.reply(amountPrompt(d), { reply_markup: cancelKeyboard() });
  });

  composer.callbackQuery(new RegExp(`^${P}go:(.+)$`), async (ctx) => {
    if (!isOwner(ctx)) return void (await ctx.answerCallbackQuery().catch(() => {}));
    await ctx.answerCallbackQuery();
    await run(ctx, ctx.match![1]!);
  });

  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const t0 = ctx.message.text.trim();
    const L = ADMIN_MENU_LABELS;
    if (t0 === L.jetonInactive || t0 === L.jetonGender || t0 === L.jetonUsers) {
      await startMode(ctx, t0 === L.jetonInactive ? "inactive" : t0 === L.jetonGender ? "gender" : "users");
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    const text = t0;
    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const id = ctx.from!.id;
    const d = (flow.data ?? {}) as Data;
    const num = Number(toAsciiDigits(text));

    if (flow.stage === "days") {
      if (!Number.isInteger(num) || num < 1 || num > 3650) return void (await ctx.reply("یک عدد صحیح بین 1 تا 3650 بفرست."));
      d.days = num;
      await save(id, "amount", d);
      await ctx.reply(amountPrompt(d), { reply_markup: cancelKeyboard() });
      return;
    }
    if (flow.stage === "ids") {
      const ids = [...new Set(toAsciiDigits(text).split(/[\s,،;]+/).filter(Boolean).map(Number))];
      if (!ids.length || ids.some((x) => !Number.isSafeInteger(x) || x <= 0)) return void (await ctx.reply("فقط آیدی‌های عددی بفرست (یکی یا چندتا)."));
      if (ids.length > MAX_IDS) return void (await ctx.reply(`حداکثر ${MAX_IDS} آیدی در هر بار.`));
      const found = await (await getDb()).collection<any>("users").find({ _id: { $in: ids }, isSeed: { $ne: true } }).project({ _id: 1 }).toArray();
      if (!found.length) return void (await ctx.reply("هیچ‌کدوم از این آیدی‌ها پیدا نشد. دوباره بفرست."));
      d.ids = found.map((u) => u._id as number);
      await save(id, "amount", d);
      const miss = ids.length - d.ids.length;
      await ctx.reply(`${d.ids.length} کاربر پیدا شد${miss ? ` (${miss} آیدی پیدا نشد و کنار گذاشته شد)` : ""}.\n${amountPrompt(d)}`, { reply_markup: cancelKeyboard() });
      return;
    }
    if (flow.stage === "amount") {
      if (!Number.isInteger(num) || num < 1 || num > MAX_AMOUNT) return void (await ctx.reply(`یک عدد صحیح بین 1 تا ${MAX_AMOUNT} بفرست.`));
      d.amount = num;
      await save(id, "msg1", d);
      await askMessage(ctx, d);
      return;
    }
    if (flow.stage === "msg1") {
      if (text.length > MAX_MSG) return void (await ctx.reply(`پیام خیلی بلنده (حداکثر ${MAX_MSG} حرف).`));
      d.messages = [text];
      await save(id, "ask2", d);
      await ctx.reply("بعد از این پیام، پیام دومی هم فرستاده بشه؟", {
        reply_markup: inlineKeyboard([[glassButton("➕ پیام دوم", `${P}add2`, "primary"), glassButton("✅ نه، ادامه", `${P}skip2`, "success")]]),
      });
      return;
    }
    if (flow.stage === "msg2") {
      if (text.length > MAX_MSG) return void (await ctx.reply(`پیام خیلی بلنده (حداکثر ${MAX_MSG} حرف).`));
      d.messages = [...(d.messages ?? []), text];
      await askConfirm(ctx, d);
      return;
    }
    return next();
  });
}
