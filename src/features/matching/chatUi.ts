import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { CHAT_CALLBACKS } from "./constants.js";

export function buildChatControlsKeyboard(lang: Language, safeChatEnabled = false) {
  const t = dictionary(lang);
  const profileLabel = requireLocked(lang, "matching.partnerProfileButton", t.matching.partnerProfileButton);
  const endChatLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton);
  // "چت ایمن" toggles to "غیرفعال کردن چت ایمن" once active — same callback
  // data either way (registerChatControls flips the actual state and just
  // re-renders this same keyboard with the new label).
  const safeChatLabel = safeChatEnabled ? "🔓 غیرفعال کردن چت ایمن" : "🔒 چت ایمن";

  return inlineKeyboard([
    [
      glassButton(profileLabel, CHAT_CALLBACKS.partnerProfile, "primary", buttonIcon("CONTACT")),
      glassButton(safeChatLabel, CHAT_CALLBACKS.safeChat, safeChatEnabled ? "success" : "primary"),
    ],
    [glassButton(endChatLabel, CHAT_CALLBACKS.endChat, "danger")],
  ]);
}
