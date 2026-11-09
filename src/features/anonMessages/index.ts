import { Context, type Api, type Composer } from "grammy";
import type { ClientSession } from "mongodb";
import type { NavaContext } from "../../bot-context.js";
import { botUsername } from "../../config/botInfo.js";
import { buttonIcon } from "../../config/emojis.js";
import { glassButton, glassUrlButton, inlineKeyboard } from "../../ui/keyboard.js";
import { escapeHtml } from "../../utils/html.js";
import { checkRateLimit } from "../../utils/rateLimit.js";
import { getUser, getUserByAnonId } from "../../db/models/user.js";
import { runInTransaction, TxAbort } from "../../db/tx.js";
import { isBlockedEitherWay } from "../../db/models/blocks.js";
import { canContact } from "../../services/ageBand.js";
import {
  assignButtonId,
  claimPendingTarget,
  clearPending,
  completePending,
  completePendingWithFlow,
  createAnonMessage,
  deleteAnonMessage,
  getAnonFlow,
  getAnonMessage,
  getAnonMessageByButtonId,
  isLegacyExposedId,
  markAnonMessageRead,
  releasePending,
  revokeButtonId,
  setAnonFlow,
  setPendingTarget,
  type AnonMessageDoc,
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

/** One neutral answer for EVERY refusal (age band, block, unknown age, vanished user): it must not tell the sender why, nor reveal that
 *  somebody blocked them or what age anybody has. */
export const ANON_UNAVAILABLE_TEXT = "امکان ارسال پیام ناشناس به این کاربر وجود نداره.";

/**
 * v1.29.2 — may `fromId` write an anonymous message to `toId` RIGHT NOW? Always read from the database (never from a user object that was
 * loaded earlier in the update or when the link was opened): the existing age-band policy (`canContact`: same band, unknown / invalid age
 * fails closed, official + staff exemptions as everywhere else) and the canonical two-way block check (`isBlockedEitherWay`).
 * Used when the link is opened, when the flow resumes, before every text is accepted, immediately before the record is created and for replies.
 */
export async function mayWriteNow(fromId: number, toId: number, session?: ClientSession): Promise<boolean> {
  if (fromId === toId) return false;
  // sequential on purpose: inside a transaction the operations of one session must not run in parallel
  const from = await getUser(fromId, session);
  const to = await getUser(toId, session);
  // v1.29.4: BOTH accounts are read fresh and either one being banned refuses (the sender may have been banned after the update's
  // middleware loaded `ctx.dbUser`)
  if (!from || !to || from.banned || to.banned) return false;
  if (!canContact(from, to)) return false;
  return !(await isBlockedEitherWay(fromId, toId, session));
}

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

/** Starts (or, if the user still has to join channels, postpones) the "type your anonymous message" step for `targetId`.
 *  `claimToken` is given when the link comes from a pending record that this worker has leased (resume path); without it the link was
 *  just opened by the user and is stored first. A pending record is removed only AFTER the compose flow exists (v1.29.4, F-24). */
async function beginCompose(ctx: NavaContext, targetId: number, claimToken?: string): Promise<void> {
  const uid = ctx.from!.id;
  /** the continuation reached its intended state (or was refused for good). Returns false when this worker no longer holds the lease:
   *  whoever holds it now (or already finished it) owns every further step, so this worker must stay silent (v1.29.6). */
  const finish = async (): Promise<boolean> => {
    if (claimToken) return completePending(uid, claimToken);
    await clearPending(uid);
    return true;
  };
  await clearAllUserFlows(uid);
  if (!(await mayWriteNow(uid, targetId))) {
    if (await finish()) await ctx.reply(ANON_UNAVAILABLE_TEXT);
    return;
  }
  if (!claimToken) await setPendingTarget(uid, targetId); // remembered until the user is allowed to write
  const ok = await requireChannelMembership(ctx, ctx.userLang);
  if (!ok) {
    // join screen shown — resumePendingAnon() continues after they verify; a leased link is handed back (not a failure)
    if (claimToken) await releasePending(uid, claimToken);
    return;
  }
  // the join screen may have taken minutes: look again before the compose step opens
  if (!(await mayWriteNow(uid, targetId))) {
    if (await finish()) await ctx.reply(ANON_UNAVAILABLE_TEXT);
    return;
  }
  if (claimToken) {
    // v1.29.6: ONE transaction — only the current lease holder removes the link AND creates the flow. A stale worker (its lease expired and
    // somebody else claimed the link, or the user opened another link) neither overwrites the newer flow nor sends a second prompt.
    if (!(await completePendingWithFlow(uid, claimToken, { _id: uid, stage: "compose", targetId }))) return;
  } else {
    await setAnonFlow({ _id: uid, stage: "compose", targetId }); // idempotent upsert: a retry can not create a second flow
    await clearPending(uid);
  }
  await ctx.reply("✉️ پیامت رو بنویس؛ بصورت کاملاً ناشناس برای این کاربر ارسال میشه 🤫", { reply_markup: cancelKeyboard() });
}

/** Called after onboarding completes (bot or Mini App) and after the force-join «عضو شدم» check succeeds: continues an anonymous-message
 *  link the user opened earlier but couldn't use yet.
 *  v1.29.4 (F-24): the pending record is LEASED, not deleted — if this worker dies or the database hiccups half-way the lease runs out and
 *  a later call (e.g. the user's next /start) continues it; attempts are bounded and the link expires after 24 h. */
export async function resumePendingAnon(ctx: NavaContext): Promise<void> {
  if (!ctx.from) return;
  // v1.29.3: `ctx.dbUser` was loaded at the START of the update, i.e. before setNicknameOnce() finished onboarding — it still says
  // NICKNAME_PENDING, so a link opened by a new user was never resumed. Read the CURRENT state instead and refresh the context copy.
  const me = await getUser(ctx.from.id);
  if (me?.onboardingStep !== "COMPLETED") return;
  ctx.dbUser = me as typeof ctx.dbUser;
  const claim = await claimPendingTarget(ctx.from.id); // atomic: at most one worker holds the link at a time
  if (!claim) return;
  const target = await getUser(claim.targetId);
  if (!target) {
    await completePending(ctx.from.id, claim.token); // the person is gone: nothing left to continue
    return;
  }
  // refusals (age band / block / ban) are final and complete the link inside beginCompose; an exception leaves the lease to expire
  await beginCompose(ctx, claim.targetId, claim.token);
}

/** Same continuation for callers that have no Telegram update (the Mini App registration): builds a minimal private-chat context around
 *  the bot API and reuses `resumePendingAnon` — no validation logic is duplicated. Never throws (the lease makes a later retry possible). */
export async function resumePendingAnonForUser(api: Api, userId: number): Promise<void> {
  try {
    const user = await getUser(userId);
    if (!user || user.onboardingStep !== "COMPLETED") return;
    const update = {
      update_id: 0,
      message: { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: "private", first_name: user.nickname ?? "" }, from: { id: userId, is_bot: false, first_name: user.nickname ?? "" } },
    };
    const ctx = new Context(update as never, api, { id: 0, is_bot: true, first_name: "", username: "" } as never) as NavaContext;
    ctx.dbUser = user;
    ctx.userLang = user.languageCode ?? "fa";
    await resumePendingAnon(ctx);
  } catch (err) {
    console.error("[anon] resume after Mini App signup failed (the pending link stays and can be continued later):", (err as Error)?.message);
  }
}

async function deliver(
  api: Api,
  input: { fromId: number; toId: number; text: string; kind: "message" | "reply"; replyToId?: string; quote?: string; sourceKey?: string }
): Promise<"ok" | "undeliverable" | "forbidden" | "duplicate"> {
  const target = await getUser(input.toId);
  if (!target || target.banned) return "undeliverable";

  // v1.29.3: the final authorization check and the insert run in ONE transaction (one snapshot), instead of separate reads followed by a
  // separate write. `sourceKey` (sender + Telegram message id) is the record's _id, so the same Telegram message can never create a
  // second record: a retry / concurrent duplicate hits the unique _id and is reported as "duplicate" (nothing is sent twice).
  // LIMITS (see docs): MongoDB snapshot isolation does not make a concurrent block / age change conflict with this transaction (they
  // write other documents), and the Telegram send happens after the commit and can not be part of any transaction.
  let doc;
  try {
    doc = await runInTransaction(async (session) => {
      if (!(await mayWriteNow(input.fromId, input.toId, session))) throw new TxAbort("forbidden");
      return createAnonMessage(
        { fromId: input.fromId, toId: input.toId, text: input.text, kind: input.kind, replyToId: input.replyToId },
        { session, id: input.sourceKey }
      );
    });
  } catch (err) {
    if (err instanceof TxAbort) return "forbidden";
    if ((err as { code?: number } | null)?.code === 11000) return "duplicate";
    throw err;
  }

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
          // the opaque handle — never `_id`, which contains the sender's Telegram id
          glassButton("پاسخ دادن", `${CB.reply}${doc.cbId ?? doc._id}`, "primary", buttonIcon("LETTER")),
          glassButton("خوندم", `${CB.read}${doc.cbId ?? doc._id}`, "success", buttonIcon("GREEN_CHECK")),
        ],
      ]),
    });
    return "ok";
  } catch {
    await deleteAnonMessage(doc._id); // recipient blocked the bot / chat unavailable
    return "undeliverable";
  }
}

/**
 * v1.29.6 (F-22 compatibility) — a button of a v1.29.3 message still carries `<senderTelegramId>:<n>`. When the recipient presses one, the
 * record gets an opaque handle and the keyboard of the pressed message is replaced with buttons that carry only the handle. If Telegram
 * refuses the edit the handle is taken back, so the old button keeps working (nothing is ever made unusable). Returns the handle the
 * keyboard now carries (the old id when nothing could be changed).
 */
async function upgradeLegacyButtons(ctx: NavaContext, doc: AnonMessageDoc, handleOnButton: string, withRead: boolean): Promise<string> {
  if (!isLegacyExposedId(doc)) return handleOnButton;
  const cbId = await assignButtonId(doc._id);
  if (!cbId) return handleOnButton;
  const row = [glassButton("پاسخ دادن", `${CB.reply}${cbId}`, "primary", buttonIcon("LETTER"))];
  if (withRead) row.push(glassButton("خوندم", `${CB.read}${cbId}`, "success", buttonIcon("GREEN_CHECK")));
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: inlineKeyboard([row]) });
    return cbId;
  } catch {
    await revokeButtonId(doc._id, cbId).catch(() => {});
    return handleOnButton;
  }
}

export function registerAnonMessages(composer: Composer<NavaContext>) {
  // ---- Someone opened a personal anonymous link ----
  composer.command("start", async (ctx, next) => {
    const match = START_PAYLOAD.exec(ctx.match?.trim() ?? "");
    if (!match || !ctx.from) {
      // recovery point (F-24): a finished user whose earlier continuation was interrupted gets it again once the lease has run out.
      // It runs AFTER the normal /start handling (which resets every open flow), otherwise that would wipe the compose step again.
      if (ctx.from && ctx.dbUser?.onboardingStep === "COMPLETED") {
        await next();
        await resumePendingAnon(ctx).catch(() => {});
        return;
      }
      return next();
    }

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
    await beginCompose(ctx, target._id); // checks age band + blocks itself
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

    // the link was opened earlier: age or block status may have changed since — refuse before anything is counted or stored
    if (!(await mayWriteNow(ctx.from!.id, flow.targetId))) {
      await setAnonFlow(null, ctx.from!.id);
      await ctx.reply(ANON_UNAVAILABLE_TEXT);
      return;
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
      sourceKey: `${ctx.from!.id}:${ctx.message.message_id}`,
    });
    await setAnonFlow(null, ctx.from!.id);
    if (delivered === "duplicate") return; // this very Telegram message was already handled — never a second record / delivery
    if (delivered === "forbidden") {
      await ctx.reply(ANON_UNAVAILABLE_TEXT);
      return;
    }
    await ctx.reply(
      delivered === "ok"
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
    // v1.29.4: the id in the button is an opaque handle, resolved on the server; ownership is checked on EVERY press. Unknown, forged and
    // somebody else's ids all get the same answer and change nothing.
    const found = await getAnonMessageByButtonId(ctx.match![1]!);
    if (!found || found.toId !== ctx.from!.id) {
      await ctx.answerCallbackQuery({ text: "این پیام دیگه در دسترس نیست.", show_alert: true });
      return;
    }
    let id = ctx.match![1]!; // the handle as it sits on the button (used to rebuild the keyboard)
    if (isLegacyExposedId(found)) id = await upgradeLegacyButtons(ctx, found, id, false);
    const first = await markAnonMessageRead(found._id, ctx.from!.id); // the local «read» status is always updated (recipient only, once)

    // v1.29.3: the button may be days old. The other person is told only if the two may STILL contact each other (age band + blocks,
    // read fresh); otherwise the read is recorded silently. The answer below never claims a notice that was not actually sent.
    let notified = false;
    if (first && (await mayWriteNow(ctx.from!.id, first.fromId))) {
      try {
        await ctx.api.sendMessage(
          first.fromId,
          first.kind === "message" ? "✅ پیام ناشناسی که فرستاده بودی خوانده شد." : "✅ پاسخی که فرستاده بودی خوانده شد."
        );
        notified = true;
      } catch {
        /* sender blocked the bot / unreachable */
      }
    }
    await ctx.answerCallbackQuery({ text: !first ? "قبلاً خوانده شده ✅" : notified ? "به فرستنده اطلاع داده شد ✅" : "خوانده شد ✅" });

    // Keep only «پاسخ دادن» on the message.
    await ctx
      .editMessageReplyMarkup({
        reply_markup: inlineKeyboard([[glassButton("پاسخ دادن", `${CB.reply}${id}`, "primary", buttonIcon("LETTER"))]]),
      })
      .catch(() => {});
  });

  // ---- «پاسخ دادن» ----
  composer.callbackQuery(new RegExp(`^${CB.reply}(.+)$`), async (ctx) => {
    const id = ctx.match![1]!; // opaque handle (or, for older messages, the record id)
    const doc = await getAnonMessageByButtonId(id);
    if (!doc || doc.toId !== ctx.from!.id) {
      await ctx.answerCallbackQuery({ text: "این پیام دیگه در دسترس نیست.", show_alert: true });
      return;
    }
    if (!(await mayWriteNow(ctx.from!.id, doc.fromId))) {
      await ctx.answerCallbackQuery({ text: ANON_UNAVAILABLE_TEXT, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    if (isLegacyExposedId(doc)) await upgradeLegacyButtons(ctx, doc, id, !doc.readAt);
    await clearAllUserFlows(ctx.from!.id);
    await setAnonFlow({ _id: ctx.from!.id, stage: "reply", targetId: doc.fromId, replyToId: doc._id });
    await ctx.reply("↩️ پاسخت رو بنویس؛ بصورت ناشناس برای فرستنده ارسال میشه.", { reply_markup: cancelKeyboard() });
  });
}
