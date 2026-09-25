import type { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { randomUUID } from "node:crypto";
import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { getUser } from "../../db/models/user.js";
import { transferRelicOnce } from "../../db/models/relic.js";
import {
  startTransferSession,
  setTransferAmount,
  getTransferSession,
  clearTransferSession,
} from "../../db/models/transferSession.js";
import { deletePreviousPrompt, recordPrompt } from "../../utils/prompts.js";
import { toAsciiDigits } from "../../utils/digits.js";
import { CHAT_CALLBACKS } from "./constants.js";
import { cancelKeyboard, clearAllUserFlows } from "../common/userFlows.js";

export function registerRelicTransfer(composer: Composer<NavaContext>) {
  composer.callbackQuery(new RegExp(`^${CHAT_CALLBACKS.transfer}:(\\d+)$`), async (ctx) => {
    const targetId = Number(ctx.match![1]);
    const t = dictionary(ctx.userLang);

    if (targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery({ text: t.relic.cannotTransferToSelf, show_alert: true });
      return;
    }
    const target = await getUser(targetId);
    if (!target) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    await clearAllUserFlows(ctx.from!.id);
    await startTransferSession(ctx.from!.id, targetId);
    const sent = await ctx.reply(t.relic.amountPrompt, { reply_markup: cancelKeyboard() });
    await recordPrompt(ctx, sent.message_id);
  });

  // Amount entry — only intercepts text while a transfer session exists
  // for this user AND no amount has been confirmed yet.
  composer.on("message:text", async (ctx, next) => {
    const session = await getTransferSession(ctx.from!.id);
    if (!session || session.amount !== undefined) return next();

    const t = dictionary(ctx.userLang);
    const raw = toAsciiDigits(ctx.message.text.trim());

    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      await ctx.reply(t.relic.invalidAmount, { reply_markup: cancelKeyboard() });
      return;
    }

    const amount = Number(raw);
    if ((ctx.dbUser?.relicBalance ?? 0) < amount) {
      await ctx.reply(t.relic.insufficientForTransfer);
      await clearTransferSession(ctx.from!.id);
      return;
    }

    const target = await getUser(session.targetId);
    if (!target) {
      await ctx.reply(t.errors.generic);
      await clearTransferSession(ctx.from!.id);
      return;
    }

    await deletePreviousPrompt(ctx);

    const confirmText = requireLocked(ctx.userLang, "relic.transferConfirmMessage", t.relic.transferConfirmMessage)(amount, `${target.anonId}`);
    const sent = await ctx.reply(confirmText, {
      reply_markup: inlineKeyboard([
        [
          glassButton(t.relic.confirmButton, CHAT_CALLBACKS.transferConfirm, "success"),
          glassButton(t.relic.cancelTransferButton, CHAT_CALLBACKS.transferCancel, "danger"),
        ],
      ]),
    });
    await setTransferAmount(ctx.from!.id, amount, sent.message_id);
  });

  composer.callbackQuery(CHAT_CALLBACKS.transferCancel, async (ctx) => {
    await clearTransferSession(ctx.from!.id);
    await ctx.answerCallbackQuery();
    const t = dictionary(ctx.userLang);
    await ctx.editMessageText(t.relic.transferCancelled).catch(() => {});
  });

  composer.callbackQuery(CHAT_CALLBACKS.transferConfirm, async (ctx) => {
    const t = dictionary(ctx.userLang);
    const session = await getTransferSession(ctx.from!.id);

    if (!session || session.amount === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Re-verify everything server-side at confirmation time — never trust
    // that nothing changed since the amount was entered.
    if (session.targetId === ctx.from!.id) {
      await ctx.answerCallbackQuery({ text: t.relic.cannotTransferToSelf, show_alert: true });
      await clearTransferSession(ctx.from!.id);
      return;
    }
    const target = await getUser(session.targetId);
    if (!target) {
      await ctx.answerCallbackQuery();
      await clearTransferSession(ctx.from!.id);
      return;
    }

    const transferId = randomUUID();
    const result = await transferRelicOnce(transferId, ctx.from!.id, session.targetId, session.amount);
    await clearTransferSession(ctx.from!.id);

    if (result.status === "insufficient") {
      await ctx.answerCallbackQuery({ text: t.relic.insufficientForTransfer, show_alert: true });
      return;
    }
    if (result.status === "invalid") {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t.relic.transferSuccess).catch(() => {});

    const targetLang: Language = target.languageCode ?? "fa";
    const senderAnonId = ctx.dbUser?.anonId ?? "?";
    const tTarget = dictionary(targetLang);
    await ctx.api.sendMessage(session.targetId, tTarget.relic.transferReceived(session.amount, `${senderAnonId}`)).catch(() => {});
  });
}
