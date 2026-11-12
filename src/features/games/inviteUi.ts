export { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
const FA = "۰۱۲۳۴۵۶۷۸۹", AR = "٠١٢٣٤٥٦٧٨٩";
/** Persian / Arabic-Indic digits → ASCII */
export function toAsciiDigitsSafe(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (c) => String(FA.includes(c) ? FA.indexOf(c) : AR.indexOf(c)));
}
