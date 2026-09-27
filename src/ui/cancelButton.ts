import { glassButton } from "./keyboard.js";
import { buttonIcon } from "../config/emojis.js";

/** Centralized Cancel/Back button, used everywhere a cancel/back action is
 *  required (per the project's "CANCEL / BACK BUTTON" requirement) — always
 *  a Glass button with the configurable EMOJI_PREMIUM_BACK icon, never a
 *  plain default button. `label` is supplied by the caller since the exact
 *  wording ("لغو" vs "بازگشت" etc.) depends on context. */
export function cancelButton(label: string, callbackData: string) {
  return glassButton(label, callbackData, "danger", buttonIcon("BACK"));
}
