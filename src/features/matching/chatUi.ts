import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassReplyButton, replyKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";

/**
 * CHANGED (v1.7.0): these three controls used to be glass INLINE buttons
 * attached to the one "شما به هم وصل شدید" message. Per request, they're
 * now a persistent colored REPLY keyboard (like the main menu) — Telegram
 * shows this at the bottom of the chat the whole time the two are
 * connected, not just on one message, and it survives past whatever
 * message it was first attached to.
 *
 * Trade-off worth knowing: a reply keyboard is matched by its exact LABEL
 * text (there's no separate callback_data), same as every other
 * reply-keyboard menu in this bot (the main menu works the same way) — see
 * matchChatControlAction() below and registerChatControls() in chat.ts,
 * which must run BEFORE the plain-text relay handler.
 */
export const CHAT_CONTROL_LABELS = {
  partnerProfile: "مشاهده پروفایل",
  safeChatOn: "چت ایمن",
  safeChatOff: "غیرفعال کردن چت ایمن",
  endChat: "پایان چت",
} as const;

export function buildChatControlsKeyboard(lang: Language, safeChatEnabled = false) {
  const t = dictionary(lang);
  const profileLabel = requireLocked(lang, "matching.partnerProfileButton", t.matching.partnerProfileButton) || CHAT_CONTROL_LABELS.partnerProfile;
  const endChatLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton) || CHAT_CONTROL_LABELS.endChat;
  const safeChatLabel = safeChatEnabled ? CHAT_CONTROL_LABELS.safeChatOff : CHAT_CONTROL_LABELS.safeChatOn;

  return replyKeyboard([
    [
      glassReplyButton(profileLabel, "primary", buttonIcon("CONTACT")),
      glassReplyButton(safeChatLabel, safeChatEnabled ? "success" : "primary"),
    ],
    [glassReplyButton(endChatLabel, "danger")],
  ]);
}

/** Strips a leading emoji (the plain fallback shown when no premium icon
 *  id is configured — see buttonIcon/glassReplyButton) so a tap still
 *  matches its label either way. */
function stripLeadingSymbols(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export type ChatControlAction = "partnerProfile" | "safeChat" | "endChat";

/** text (in ANY language's label) -> which chat-control action it means,
 *  or undefined if it doesn't match any of them. */
export function matchChatControlAction(text: string, lang: Language): ChatControlAction | undefined {
  const t = dictionary(lang);
  const profileLabel = requireLocked(lang, "matching.partnerProfileButton", t.matching.partnerProfileButton) || CHAT_CONTROL_LABELS.partnerProfile;
  const endChatLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton) || CHAT_CONTROL_LABELS.endChat;

  const candidates: Array<[string, ChatControlAction]> = [
    [profileLabel, "partnerProfile"],
    [CHAT_CONTROL_LABELS.partnerProfile, "partnerProfile"],
    [CHAT_CONTROL_LABELS.safeChatOn, "safeChat"],
    [CHAT_CONTROL_LABELS.safeChatOff, "safeChat"],
    [endChatLabel, "endChat"],
    [CHAT_CONTROL_LABELS.endChat, "endChat"],
  ];
  const stripped = stripLeadingSymbols(text);
  for (const [label, action] of candidates) {
    if (text === label || stripped === stripLeadingSymbols(label)) return action;
  }
  return undefined;
}
