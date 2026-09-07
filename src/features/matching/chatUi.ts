import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { CHAT_CALLBACKS } from "./constants.js";

export function buildChatControlsKeyboard(lang: Language) {
  const t = dictionary(lang);
  const profileLabel = requireLocked(lang, "matching.partnerProfileButton", t.matching.partnerProfileButton);
  const safeChatLabel = requireLocked(lang, "matching.safeChatButton", t.matching.safeChatButton);
  const endChatLabel = requireLocked(lang, "matching.endChatButton", t.matching.endChatButton);

  return inlineKeyboard([
    [
      glassButton(profileLabel, CHAT_CALLBACKS.partnerProfile, "primary", buttonIcon("CONTACT")),
      glassButton(safeChatLabel, CHAT_CALLBACKS.safeChat, "primary", buttonIcon("LOCK")),
    ],
    [glassButton(endChatLabel, CHAT_CALLBACKS.endChat, "danger")],
  ]);
}
