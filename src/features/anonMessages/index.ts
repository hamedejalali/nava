import type { Api, Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { botUsername } from "../../config/botInfo.js";
import { buttonIcon } from "../../config/emojis.js";
import { glassButton, glassUrlButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { getUser, getUserByAnonId } from "../../db/models/user.js";
import {
  createAnonMessage,
  deleteAnonMessage,
  getAnonFlow,
  getAnonMessage,
  markAnonMessageRead,
  peekPendingTarget,
  setAnonFlow,
  setPendingTarget,
  takePendingTarget,
} from "../../db/models/anonMessages.js";
import { requireChannelMembership } from "../forcejoin/guard.js";
import { isFlowCancelSignal } from "../admin/flowState.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";

/**
 * «لینک ناشناس من» — anonymous direct messages.
 *
 *  User 1 taps the button -> gets a personal link  t.me/<bot>?start=msg_<anonId>
 *  User 2 opens it (must be signed up + joined the required channels) and
 *  types a message -> User 1 receives it WITHOUT knowing who sent it, with
 *  two glass buttons: «پاسخ دادن» and «خوندم».
 *   - «خوندم»   -> User 2 is told the message was read.
 *   - «پاسخ دادن» -> User 1 types a reply, delivered to User 2 (still anonymous
 *                   in the sense that nothing but the text is shared).
 */

const START_PAYLOAD = /^msg_(user_[A-Za-z0-9]{6})$/;
const CB = { reply: "anon:reply:", read: "anon:read:" };
const MAX_LENGTH = 1000;

export function anonymousLinkFor(anonId: string): string {
  return `https://t.me/${botUsername()}?start=msg_${anonId}`;
}

/** «لینک ناشناس من» button: sends the user's own personal link. */
export async function sendMyAnonymousLink(ctx: NavaContext): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const link = anonymousLinkFor(user.anonId);
  const shareText = "بصورت کاملاً ناشناس بهم پیام بده 👇";
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;

  await ctx.reply(
    `🔗 لینک ناشناس شما آماده‌ست 👇\n\n${link}\n\n` +
      `این لینک رو برای دوستات بفرست یا توی استوری/کانال/بیو بذار. هرکسی روش بزنه می‌تونه بصورت کاملاً ناشناس برات پیام بفرسته و تو هم می‌تونی ناشناس جوابش رو بدی 🤫`,
    {
      reply_markup: inlineKeyboard([[glassUrlButton("اشتراک‌گذاری لینک", shareUrl, "primary", buttonIcon("LETTER"))]]),
      link_preview_options: { is_disabled: true },
    }
  );
}

/** Starts (or, if the user still has to join channels, postpones) the
 *  "type your anonymous message" step for `targetId`. */
async function beginCompose(ctx: NavaContext, targetId: number): Promise<void> {
  await clearAllUserFlows(ctx.from!.id);
  await setPendingTarget(ctx.from!.id, targetId); // remembered until the user is allowed to write
  const ok = await requireChannelMembership(ctx, ctx.userLang);
  if (!ok) return; // join screen shown — resumePendingAnon() continues after they verify
  await takePendingTarget(ctx.from!.id);
  await setAnonFlow({ _id: ctx.from!.id, stage: "compose", targetId });
  await ctx.reply("✉️ پیامت رو بنویس؛ بصورت کاملاً ناشناس برای این کاربر ارسال میشه 🤫", { reply_markup: cancelKeyboard() });
}

/** Called after onboarding completes and after the force-join «عضو شدم»
 *  check succeeds: continues an anonymous-message link the user opened
 *  earlier but couldn't use yet. */
export async function resumePendingAnon(ctx: NavaContext): Promise<void> {
  if (!ctx.from || ctx.dbUser?.onboardingStep !== "COMPLETED") return;
  const targetId = await peekPendingTarget(ctx.from.id);
  if (!targetId) return;
  const target = await getUser(targetId);
  if (!target) {
    await takePendingTarget(ctx.from.id);
    return;
  }
  await beginCompose(ctx, targetId);
}

async function deliver(
  api: Api,
  input: { fromId: number; toId: number; text: string; kind: "message" | "reply"; replyToId?: string; quote?: string }
): Promise<boolean> {
  const target = await getUser(input.toId);
  if (!target || target.banned) return false;

  const doc = await createAnonMessage({
    fromId: input.fromId,
    toId: input.toId,
    text: input.text,
    kind: input.kind,
    replyToId: input.replyToId,
  });

  const header =
    input.kind === "message"
      ? "📩 کاربری بصورت ناشناس پیامی برای شما ارسال کرد 👇"
      : "↩️ پاسخی برای پیام ناشناسی که فرستاده بودی رسید 👇";
  const quote = input.quote ? `<i>در پاسخ به: «${escapeHtml(input.quote)}»</i>\n\n` : "";
  const body = `${header}\n\n${quote}<blockquote>${escapeHtml(input.text)}</blockquote>`;

  try {
    await api.sendMessage(input.toId, body, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [
          glassButton("پاسخ دادن", `${CB.reply}${doc._id}`, "primary", buttonIcon("LETTER")),
          glassButton("خوندم", `${CB.read}${doc._id}`, "success", buttonIcon("GREEN_CHECK")),
        ],
      ]),
    });
    return true;
  } catch {
    await deleteAnonMessage(doc._id); // recipient blocked the bot / chat unavailable
    return false;
  }
}

export function registerAnonMessages(composer: Composer<NavaContext>) {
  // ---- Someone opened a personal anonymous link ----
  composer.command("start", async (ctx, next) => {
    const match = START_PAYLOAD.exec(ctx.match?.trim() ?? "");
    if (!match || !ctx.from) return next();

    const target = await getUserByAnonId(match[1]!);
    if (!target) {
      await ctx.reply("این لینک معتبر نیست یا کاربرش دیگه وجود نداره.");
      return;
    }
    if (target._id === ctx.from.id) {
      await ctx.reply("این لینک خودته 😄 برای دوستات بفرستش تا بتونن ناشناس بهت پیام بدن.");
      return;
    }

    if (ctx.dbUser?.onboardingStep !== "COMPLETED") {
      // New / unfinished user: sign up first, the anonymous message
      // step continues automatically when onboarding is done.
      await setPendingTarget(ctx.from.id, target._id);
      return next();
    }
    await beginCompose(ctx, target._id);
  });

  // ---- The message / reply text itself ----
  composer.on("message:text", async (ctx, next) => {
    const flow = await getAnonFlow(ctx.from!.id);
    if (!flow) return next();

    const text = ctx.message.text.trim();
    if (isFlowCancelSignal(text)) {
      await setAnonFlow(null, ctx.from!.id);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }
    if (text.length === 0 || text.length > MAX_LENGTH) {
      await ctx.reply(`پیام باید بین ۱ تا ${MAX_LENGTH} کاراکتر باشه.`, { reply_markup: cancelKeyboard() });
      return;
    }

    if (flow.stage === "compose") {
      // Re-check the required channels at send time as well.
      if (!(await requireChannelMembership(ctx, ctx.userLang))) return;
    }

    const { allowed } = await checkRateLimit(ctx.from!.id, `anon:${flow.targetId}`, 5, 10 * 60 * 1000);
    if (!allowed) {
      await ctx.reply("خیلی پشت‌سرهم پیام می‌فرستی 🙏 چند دقیقه‌ی دیگه دوباره امتحان کن.", { reply_markup: cancelKeyboard() });
      return;
    }

    let quote: string | undefined;
    if (flow.stage === "reply" && flow.replyToId) {
      const original = await getAnonMessage(flow.replyToId);
      if (original) quote = original.text.length > 80 ? `${original.text.slice(0, 80)}…` : original.text;
    }

    const delivered = await deliver(ctx.api, {
      fromId: ctx.from!.id,
      toId: flow.targetId,
      text,
      kind: flow.stage === "compose" ? "message" : "reply",
      replyToId: flow.replyToId,
      quote,
    });
    await setAnonFlow(null, ctx.from!.id);
    await ctx.reply(
      delivered
        ? flow.stage === "compose"
          ? "✅ پیامت بصورت ناشناس ارسال شد."
          : "✅ پاسخت ارسال شد."
        : "❌ پیام تحویل داده نشد (احتمالاً کاربر ربات رو بلاک کرده یا دیگه در دسترس نیست)."
    );
  });

  // Only text is supported for now — say so instead of silently ignoring
  // (and never let a photo here become a profile picture).
  composer.on("message", async (ctx, next) => {
    if (ctx.message.text) return next();
    const flow = await getAnonFlow(ctx.from!.id);
    if (!flow) return next();
    await ctx.reply("فعلاً فقط پیام متنی قبول میشه ✍️", { reply_markup: cancelKeyboard() });
  });

  // ---- «خوندم» ----
  composer.callbackQuery(new RegExp(`^${CB.read}(.+)$`), async (ctx) => {
    const id = ctx.match![1]!;
    const first = await markAnonMessageRead(id, ctx.from!.id);
    await ctx.answerCallbackQuery({ text: first ? "به فرستنده اطلاع داده شد ✅" : "قبلاً خوانده شده ✅" });

    // Keep only «پاسخ دادن» on the message.
    await ctx
      .editMessageReplyMarkup({
        reply_markup: inlineKeyboard([[glassButton("پاسخ دادن", `${CB.reply}${id}`, "primary", buttonIcon("LETTER"))]]),
      })
      .catch(() => {});

    if (first) {
      await ctx.api
        .sendMessage(
          first.fromId,
          first.kind === "message" ? "✅ پیام ناشناسی که فرستاده بودی خوانده شد." : "✅ پاسخی که فرستاده بودی خوانده شد."
        )
        .catch(() => {});
    }
  });

  // ---- «پاسخ دادن» ----
  composer.callbackQuery(new RegExp(`^${CB.reply}(.+)$`), async (ctx) => {
    const id = ctx.match![1]!;
    const doc = await getAnonMessage(id);
    if (!doc || doc.toId !== ctx.from!.id) {
      await ctx.answerCallbackQuery({ text: "این پیام دیگه در دسترس نیست.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await clearAllUserFlows(ctx.from!.id);
    await setAnonFlow({ _id: ctx.from!.id, stage: "reply", targetId: doc.fromId, replyToId: id });
    await ctx.reply("↩️ پاسخت رو بنویس؛ بصورت ناشناس برای فرستنده ارسال میشه.", { reply_markup: cancelKeyboard() });
  });
}
