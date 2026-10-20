/**
 * XP amounts — ONE strict parser used by every place that accepts an amount from outside
 * (Wallet API, user-to-user transfer, ...). The currency is whole XP only: no decimals, no signs, no
 * exponent notation, no separators, no leading zeros, nothing above MAX_XP_AMOUNT.
 *
 * Nothing here ever calls Number() on an unchecked string: the digits are validated first and the length
 * is capped, so "99999999999999999999999" can never become a rounded (unsafe) float.
 */

/** Hard ceiling of a single XP amount (1 billion). Far below Number.MAX_SAFE_INTEGER, so sums never overflow. */
export const MAX_XP_AMOUNT = 1_000_000_000;

export type XpAmountError = "not_integer" | "not_positive" | "too_large";

export type XpAmountResult = { ok: true; amount: number } | { ok: false; error: XpAmountError };

const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC = "٠١٢٣٤٥٦٧٨٩";

/** Persian / Arabic-Indic digits -> ASCII (only for text typed by humans in the bot). */
export function normalizeDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN.indexOf(d);
    return String(p >= 0 ? p : ARABIC.indexOf(d));
  });
}

/**
 * Parses an amount that must be a positive whole number of XP.
 *  - `number` input must already be a safe integer (1.5, NaN, Infinity, -3 are refused);
 *  - `string` input must be only ASCII digits (after optional human-typing digit normalisation) — "0.5", "1.01",
 *    "2.75", "1e3", "+5", "-5", "1,000", " 5 " (with inner spaces) are all refused;
 *  - anything else (null, boolean, object, array) is refused.
 */
export function parseXpAmount(raw: unknown, opts: { humanDigits?: boolean } = {}): XpAmountResult {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return { ok: false, error: "not_integer" };
    if (raw <= 0) return { ok: false, error: "not_positive" };
    if (raw > MAX_XP_AMOUNT) return { ok: false, error: "too_large" };
    return { ok: true, amount: raw };
  }
  if (typeof raw !== "string") return { ok: false, error: "not_integer" };
  let s = raw.trim();
  if (opts.humanDigits) s = normalizeDigits(s);
  if (!/^\d+$/.test(s)) return { ok: false, error: "not_integer" };
  if (/^0\d/.test(s)) {
    if (!opts.humanDigits) return { ok: false, error: "not_integer" }; // machine input must be canonical: "007" is refused
    s = s.replace(/^0+(?=\d)/, ""); // typed by a human: "007" -> "7"
  }
  if (s.length > 10) return { ok: false, error: "too_large" }; // longer than 1_000_000_000 for sure; never reaches Number()
  const n = Number(s);
  if (n <= 0) return { ok: false, error: "not_positive" };
  if (n > MAX_XP_AMOUNT) return { ok: false, error: "too_large" };
  return { ok: true, amount: n };
}
