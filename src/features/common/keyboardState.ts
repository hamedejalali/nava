import type { Transformer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { getDb } from "../../db/connect.js";
import { buildMainMenuReplyKeyboard, matchMainMenuAction } from "../menu/mainMenu.js";
import { ADMIN_CATEGORY_LABELS, ADMIN_MENU_LABELS, buildAdminReplyKeyboard } from "../admin/menu.js";
import { isAdmin } from "../admin/constants.js";
import { removeReplyKeyboard } from "../../ui/keyboard.js";
import { CANCEL_LABEL, DONE_LABEL } from "./cancelLabel.js";
import { KEYBOARD_REV } from "../../config/version.js";

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
  /** KEYBOARD_REV of the main/admin keyboard last sent to this chat */
  rev?: string;
  at: Date;
}

const col = async () => (await getDb()).collection<KbState>("kb_state");

export function classifyKeyboard(rows: Array<Array<{ text?: string }>>): Kind {
  const texts = rows.flat().map((b) => String(b?.text ?? ""));
  if (texts.length === 1 && (texts[0] === CANCEL_LABEL || texts[0] === DONE_LABEL)) return "cancel";
  if (texts.includes(ADMIN_MENU_LABELS.close) || texts.includes(ADMIN_CATEGORY_LABELS.back) || texts.includes(ADMIN_CATEGORY_LABELS.backSettings)) return "admin";
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
        await c.updateOne({ _id: p.chat_id }, { $set: { kind, at: new Date(), ...(kind === "main" || kind === "admin" ? { rev: KEYBOARD_REV } : {}), ...(kind === "cancel" && prevKind ? { prev: prevKind } : {}) } }, { upsert: true });
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
  const names = ["profile_edit_flow", "verify_flow", "report_flow", "anon_msg_flow", "feedback_flow", "admin_flow_state", "admin_relic_flow", "verify_reject_flow", "relic_transfer_sessions", "wallet_deposit_flow", "admin_channel_add", "user_search_flow"];
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

/** True when this chat still shows a main/admin keyboard from an OLDER release (or none is known) → it must be refreshed once. */
export function keyboardIsStale(st: KbState | null): boolean {
  if (!st) return true;
  if (st.kind === "main" || st.kind === "admin") return st.rev !== KEYBOARD_REV;
  return st.kind === "none" ? true : false; // "cancel" / "other": somebody is mid-step — leave them alone
}

/**
 * After-handler middleware.
 *  1) nothing pending any more but the red cancel keyboard is still shown → restore;
 *  2) v1.27: the keyboard on the user's screen is from an older release → send the fresh one, once, silently, on their very next tap/message
 *     (no more «کاربر باید /start بزنه تا آپدیت بیاد»).
 */
export async function restoreKeyboardIfDone(ctx: NavaContext, next: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  await next();
  try {
    if (!ctx.from || ctx.chat?.type !== "private" || !(ctx.message || ctx.callbackQuery)) return;
    const st = await (await col()).findOne({ _id: ctx.from.id });
    if (st?.kind === "cancel") {
      if (st.at && new Date(st.at).getTime() >= startedAt) return; // this very update just showed the red cancel keyboard = a prompt is waiting for an answer
      if (await hasPendingInput(ctx.from.id)) return;
      await sendRestore(ctx, st.prev === "admin" ? "🛡 پنل مدیریت" : "🏠 منوی اصلی");
      return;
    }
    if (!keyboardIsStale(st) || ctx.dbUser?.onboardingStep !== "COMPLETED") return;
    if (await hasPendingInput(ctx.from.id)) return;
    // an admin whose keyboard we have no record of: panel buttons / admin callbacks / any non-menu text mean he is inside the panel → give him the panel
    const txt = ctx.message?.text ?? "";
    const inPanelGuess = !st && (ctx.callbackQuery?.data?.startsWith("admin") || (txt !== "" && !txt.startsWith("/") && !matchMainMenuAction(txt)));
    const asAdmin = isAdmin(ctx) && (st?.kind === "admin" || st?.prev === "admin" || !!inPanelGuess);
    const markup = asAdmin ? buildAdminReplyKeyboard(ctx) : buildMainMenuReplyKeyboard(ctx.userLang as any);
    const sent = await ctx.reply("🔄 مویا به‌روز شد؛ منوت هم تازه شد.", { reply_markup: markup, disable_notification: true }).then(() => true, () => false);
    // recorded here too (not only by the send transformer), so a refresh can never repeat on every message
    if (sent) await (await col()).updateOne({ _id: ctx.from.id }, { $set: { kind: asAdmin ? "admin" : "main", rev: KEYBOARD_REV, at: new Date() } }, { upsert: true });
  } catch {
    /* never fail an update because of keyboard bookkeeping */
  }
}
