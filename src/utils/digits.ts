const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Converts Persian and Arabic-Indic digits inside a string to plain ASCII
 *  digits, so age input (and similar numeric input) is recognized
 *  regardless of the keyboard/script the user typed with. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const pIdx = PERSIAN_DIGITS.indexOf(ch);
    if (pIdx !== -1) return String(pIdx);
    const aIdx = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (aIdx !== -1) return String(aIdx);
    return ch;
  });
}
