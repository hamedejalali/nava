import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getGateSettings, setGateEnabled, setGateField } from "../../db/models/reactionGate.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { isAdmin } from "./constants.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { ADMIN_MENU_LABELS } from "./menu.js";

const CB = {
  toggle: "admin:rg:toggle",
  message: "admin:rg:message",
  button: "admin:rg:button",
  url: "admin:rg:url",
};
const FLOW = "reactiongate";

async function statusView() {
  const s = await getGateSettings();
  const text =
    `🎯 تنظیم گیت ری‌اکشن\n\n` +
    `وضعیت: ${s.enabled ? "روشن ✅" : "خاموش ❌"}\n\n` +
    `پیام: ${s.message}\n` +
    `متن دکمه: ${s.buttonText}\n` +
    `لینک: ${s.buttonUrl || "— تنظیم نشده —"}\n\n` +
    `کاربر بعد از دیدن پیام، ۱۰ ثانیه (بدون اینکه ببینه) باید صبر کنه؛ اگه قبل از تموم شدنش «بررسی» رو بزنه، بهش گفته میشه هنوز انجام نداده. با تغییر پیام/دکمه/لینک، همه‌ی کاربرا دوباره باید از گیت رد بشن.`;
  const reply_markup = inlineKeyboard([
    [glassButton(s.enabled ? "خاموش کردن" : "روشن کردن", CB.toggle, s.enabled ? "danger" : "success")],
    [glassButton("ویرایش پیام", CB.message, "primary"), glassButton("ویرایش متن دکمه", CB.button, "primary")],
    [glassButton("ویرایش لینک", CB.url, "primary")],
  ]);
  return { text, reply_markup };
}

/** Accepts https://…, http://…, tg://… or @username (→ https://t.me/username). */
function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (/^@[A-Za-z0-9_]{4,}$/.test(v)) return `https://t.me/${v.slice(1)}`;
  if (/^(https?|tg):\/\/\S+$/i.test(v)) return v;
  return null;
}

export function registerAdminReactionGate(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.reactionGate) {
      await setAdminFlow(ctx.from!.id, null);
      const view = await statusView();
      await ctx.reply(view.text, { reply_markup: view.reply_markup });
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();

    if (isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    let saved = false;
    if (flow.stage === "message") {
      if (text.length > 1000) {
        await ctx.reply("پیام نباید بیشتر از ۱۰۰۰ کاراکتر باشه.", { reply_markup: cancelKeyboard() });
        return;
      }
      await setGateField("message", text, ctx.from!.id);
      saved = true;
    } else if (flow.stage === "button") {
      if (text.length > 60) {
        await ctx.reply("متن دکمه نباید بیشتر از ۶۰ کاراکتر باشه.", { reply_markup: cancelKeyboard() });
        return;
      }
      await setGateField("buttonText", text, ctx.from!.id);
      saved = true;
    } else if (flow.stage === "url") {
      const url = normalizeUrl(text);
      if (!url) {
        await ctx.reply("لینک معتبر نیست. با https:// شروع بشه (یا یه @یوزرنیم بفرست).", { reply_markup: cancelKeyboard() });
        return;
      }
      await setGateField("buttonUrl", url, ctx.from!.id);
      saved = true;
    }

    if (saved) {
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("✅ ذخیره شد.");
      const view = await statusView();
      await ctx.reply(view.text, { reply_markup: view.reply_markup });
      return;
    }
    return next();
  });

  composer.callbackQuery(CB.toggle, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = await getGateSettings();
    if (!s.enabled && !s.buttonUrl) {
      await ctx.answerCallbackQuery({ text: "اول لینک دکمه رو تنظیم کن.", show_alert: true });
      return;
    }
    await setGateEnabled(!s.enabled, ctx.from!.id);
    await ctx.answerCallbackQuery({ text: s.enabled ? "خاموش شد" : "روشن شد" });
    const view = await statusView();
    await ctx.editMessageText(view.text, { reply_markup: view.reply_markup }).catch(() => {});
  });

  const beginEdit = (stage: "message" | "button" | "url", prompt: string) => async (ctx: NavaContext) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage });
    await ctx.reply(prompt, { reply_markup: cancelKeyboard() });
  };
  composer.callbackQuery(CB.message, beginEdit("message", "متن پیام گیت رو بفرست (مثلاً: ابتدا ۱۰ پست آخر کانالمو ری‌اکشن بزن ...):"));
  composer.callbackQuery(CB.button, beginEdit("button", "متن دکمه‌ی شیشه‌ای رو بفرست:"));
  composer.callbackQuery(CB.url, beginEdit("url", "لینک دکمه رو بفرست (https://... یا @یوزرنیم):"));
}
