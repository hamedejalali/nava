import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { getAdminFlow, isFlowCancelSignal, setAdminFlow } from "./flowState.js";
import { logAdminAction } from "../../db/models/adminLog.js";
import { currentEmojiOverrides, emojiKeys, setEmojiOverride, setPremiumEnabled, loadEmojiConfig } from "../../db/models/emojiConfig.js";
import { DEFAULT_EMOJI, cleanEmojiId, emojiRaw, premiumEnabled, type EmojiKey } from "../../config/emojis.js";
import { env } from "../../config/env.js";

const P = "adm:emo:";
const FLOW = "emoji";
const PER_PAGE = 12;

async function view(page: number) {
  await loadEmojiConfig(true);
  const keys = emojiKeys();
  const pages = Math.max(1, Math.ceil(keys.length / PER_PAGE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const ov = currentEmojiOverrides();
  const rows = [] as any[][];
  const slice = keys.slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE);
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(
      slice.slice(i, i + 2).map((k) => {
        const raw = emojiRaw(k);
        const premium = !!cleanEmojiId(raw);
        const plain = DEFAULT_EMOJI[k];
        return glassButton(`${plain} ${k}${premium ? " ⭐" : ""}${ov.map[k] ? " ✏️" : ""}`, `${P}e:${k}`, ov.map[k] ? "success" : "primary");
      }),
    );
  }
  const nav = [] as any[];
  if (pg > 0) nav.push(glassButton("◀️ قبلی", `${P}p:${pg - 1}`, "primary"));
  if (pg < pages - 1) nav.push(glassButton("بعدی ▶️", `${P}p:${pg + 1}`, "primary"));
  if (nav.length) rows.push(nav);
  const on = premiumEnabled();
  rows.unshift([glassButton(on ? "⭐ ایموجی پرمیوم: روشن (برای خاموش کردن بزن)" : "⚪️ ایموجی پرمیوم: خاموش (برای روشن کردن بزن)", `${P}tg`, on ? "success" : "danger")]);
  const text =
    "✨ <b>ایموجی‌ها</b>\n\n" +
    `وضعیت پرمیوم: ${on ? "🟢 روشن" : "🔴 خاموش (همه‌جا ایموجی معمولی)"}${ov.enabled === undefined ? ` — از ${escapeHtml(String(env.PREMIUM_EMOJI_ENABLED ? "env: روشن" : "env: خاموش"))}` : " — از پنل"}\n` +
    "⭐ یعنی برای اون ایموجی آیدی پرمیوم تنظیم شده، ✏️ یعنی از پنل عوض شده.\n" +
    "یه ایموجی رو بزن تا عوضش کنی.";
  return { text, kb: inlineKeyboard(rows), page: pg };
}

async function show(ctx: NavaContext, edit: boolean, page = 0) {
  const v = await view(page);
  const o = { parse_mode: "HTML" as const, reply_markup: v.kb };
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(v.text, o);
      return;
    } catch (err: any) {
      if (/not modified/i.test(String(err?.description ?? err?.message))) return;
    }
  }
  await ctx.reply(v.text, o);
}

export function registerEmojiAdmin(composer: Composer<NavaContext>) {
  const guard = async (ctx: NavaContext) => {
    if (isOwner(ctx)) return true;
    await ctx.answerCallbackQuery({ text: "فقط مالک", show_alert: true }).catch(() => {});
    return false;
  };

  composer.on("message", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text?.trim();
    if (text === ADMIN_MENU_LABELS.emojis) {
      await setAdminFlow(ctx.from!.id, null);
      await show(ctx, false);
      return;
    }
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== FLOW) return next();
    if (text && isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    const key = flow.data?.key as EmojiKey;
    if (text === "پیش‌فرض") {
      await setEmojiOverride(key, null);
      await setAdminFlow(ctx.from!.id, null);
      await ctx.reply("✅ به پیش‌فرض برگشت.");
      await show(ctx, false);
      return;
    }
    // a premium emoji sent as a message carries its id in the entities
    const ce = (ctx.message.entities ?? []).find((e: any) => e.type === "custom_emoji") as any;
    let value: string | undefined;
    if (ce?.custom_emoji_id) value = `${ce.custom_emoji_id} ${text!.slice(ce.offset, ce.offset + ce.length)}`.trim();
    else if (text) value = text;
    if (!value || !(await setEmojiOverride(key, value))) {
      await ctx.reply("این مقدار معتبر نیست. یه ایموجی پرمیوم، آیدی عددی یا ایموجی معمولی بفرست.", { reply_markup: cancelKeyboard() });
      return;
    }
    await logAdminAction(ctx.from!.id, "emoji_set", `${key}`);
    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply("✅ ذخیره شد.");
    await show(ctx, false);
  });

  composer.callbackQuery(`${P}tg`, async (ctx) => {
    if (!(await guard(ctx))) return;
    const next = !premiumEnabled();
    await setPremiumEnabled(next);
    await logAdminAction(ctx.from!.id, "premium_emoji_toggle", String(next));
    await ctx.answerCallbackQuery({ text: next ? "روشن شد" : "خاموش شد" });
    await show(ctx, true);
  });

  composer.callbackQuery(/^adm:emo:p:(\d+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    await show(ctx, true, Number(ctx.match![1]));
  });

  composer.callbackQuery(/^adm:emo:e:([A-Z_]+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const key = ctx.match![1] as EmojiKey;
    if (!(key in DEFAULT_EMOJI)) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery();
    await setAdminFlow(ctx.from!.id, { flow: FLOW, stage: "value", data: { key } });
    await ctx.reply(
      `ایموجی «${key}» (فعلی: ${DEFAULT_EMOJI[key]}).\nیه ایموجی پرمیوم، آیدی عددی اون، یا یه ایموجی معمولی بفرست.\nبرای برگشت به پیش‌فرض بنویس «پیش‌فرض».`,
      { reply_markup: cancelKeyboard() },
    );
  });
}
