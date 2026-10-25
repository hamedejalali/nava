import type { Transformer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { buildMainMenuReplyKeyboard, matchMainMenuAction } from "../menu/mainMenu.js";
import { ADMIN_CATEGORY_LABELS, ADMIN_MENU_LABELS, buildAdminReplyKeyboard } from "../admin/menu.js";
import { isAdmin } from "../admin/constants.js";
import { removeReplyKeyboard } from "../../ui/keyboard.js";
import { CANCEL_LABEL, DONE_LABEL } from "./cancelLabel.js";

/**
 * Cancel rule (v1.26): whenever the bot waits for something the user must type/send, the ONLY keyboard on screen is one red
 * «❌ لغو» reply button. That keyboard replaces the main menu / admin panel keyboard, so something has to put the old one
 * back afterwards. This module remembers, per private chat, WHICH reply keyboard is currently shown (recorded from every
 * outgoing message by `keyboardStateTransformer`) and `restoreKeyboardIfDone` — an after-handler middleware — brings the
 * previous one back as soon as no input step is pending any more (finished, cancelled or abandoned by tapping a menu button).
 */
type Kind = "cancel" | "admin" | "main" | "other" | "none";
interface KbState {
  _id: number;
  kind: Kind;
  prev?: "admin" | "main";
  at: Date;
}

const col = async () => (await getDb()).collection<KbState>("kb_state");

export function classifyKeyboard(rows: Array<Array<{ text?: string }>>): Kind {
  const texts = rows.flat().map((b) => String(b?.text ?? ""));
  if (texts.length === 1 && (texts[0] === CANCEL_LABEL || texts[0] === DONE_LABEL)) return "cancel";
  if (texts.includes(ADMIN_MENU_LABELS.close) || texts.includes(ADMIN_CATEGORY_LABELS.back)) return "admin";
  if (texts.some((t) => !!matchMainMenuAction(t))) return "main";
  return "other";
}

const SEND = new Set(["sendMessage", "sendPhoto", "sendVideo", "sendDocument", "sendAnimation", "sendSticker", "sendVoice", "sendAudio", "sendVideoNote", "sendContact", "sendLocation", "sendDice", "sendPoll"]);

export const keyboardStateTransformer: Transformer = async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  try {
    const p: any = payload;
    if (res.ok && SEND.has(method) && typeof p?.chat_id === "number" && p.chat_id > 0 && p.reply_markup) {
      const rm = p.reply_markup;
      let kind: Kind | null = null;
      if (rm.remove_keyboard) kind = "none";
      else if (Array.isArray(rm.keyboard)) kind = classifyKeyboard(rm.keyboard);
      if (kind) {
        const c = await col();
        const cur = await c.findOne({ _id: p.chat_id });
        const prevKind: "admin" | "main" | undefined = cur?.kind === "admin" || cur?.kind === "main" ? cur.kind : cur?.prev;
        await c.updateOne({ _id: p.chat_id }, { $set: { kind, at: new Date(), ...(kind === "cancel" && prevKind ? { prev: prevKind } : {}) } }, { upsert: true });
      }
    }
  } catch {
    /* bookkeeping only — never break a send */
  }
  return res;
};

/** True while any "waiting for the user's next message" step is stored for this user. */
export async function hasPendingInput(userId: number): Promise<boolean> {
  const db = await getDb();
  const names = ["profile_edit_flow", "verify_flow", "report_flow", "anon_msg_flow", "feedback_flow", "admin_flow_state", "admin_relic_flow", "verify_reject_flow", "relic_transfer_sessions", "wallet_deposit_flow", "admin_channel_add"];
  const hits = await Promise.all(names.map((n) => db.collection(n).findOne({ _id: userId as never }, { projection: { _id: 1 } })));
  return hits.some(Boolean);
}

/** Puts the previous reply keyboard back. `text` is the message that carries it. */
export async function sendRestore(ctx: NavaContext, text: string): Promise<void> {
  const st = await (await col()).findOne({ _id: ctx.from!.id });
  let markup: any;
  if (st?.prev === "admin" && isAdmin(ctx)) markup = buildAdminReplyKeyboard(ctx);
  else if (ctx.dbUser?.onboardingStep === "COMPLETED") markup = buildMainMenuReplyKeyboard(ctx.userLang as any);
  else markup = removeReplyKeyboard();
  await ctx.reply(text, { reply_markup: markup }).catch(() => {});
}

/** After-handler middleware: nothing pending any more but the red cancel keyboard is still shown → restore. */
export async function restoreKeyboardIfDone(ctx: NavaContext, next: () => Promise<void>): Promise<void> {
  await next();
  try {
    if (!ctx.from || ctx.chat?.type !== "private" || !(ctx.message || ctx.callbackQuery)) return;
    const st = await (await col()).findOne({ _id: ctx.from.id });
    if (st?.kind !== "cancel") return;
    if (await hasPendingInput(ctx.from.id)) return;
    await sendRestore(ctx, st.prev === "admin" ? "🛡 پنل مدیریت" : "🏠 منوی اصلی");
  } catch {
    /* never fail an update because of keyboard bookkeeping */
  }
}
