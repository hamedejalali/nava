/**
 * Username badges (shown next to a name in the Mini App, like Twitter/Instagram/Telegram badges).
 * The ARTWORK lives in public/miniapp/badges.js (original SVG drawings, same ids); this file is the server-side
 * catalogue: which ids exist, their Persian names, and which of them replace the default blue tick.
 *
 * The blue tick itself is NOT a badge you assign: it is the `verified` flag (admin panel / verify flow). A person can
 * hold several badges at once; any `tick-*` badge swaps the colour of the verification tick.
 */
export interface BadgeDef {
  id: string;
  label: string;
  group: "tick" | "star" | "tg" | "ig";
}

export const BADGES: readonly BadgeDef[] = [
  { id: "tick-gold", label: "تیک طلایی", group: "tick" },
  { id: "tick-green", label: "تیک سبز", group: "tick" },
  { id: "tick-purple", label: "تیک بنفش", group: "tick" },
  { id: "tick-red", label: "تیک قرمز", group: "tick" },
  { id: "tick-black", label: "تیک مشکی", group: "tick" },
  { id: "star-gold", label: "ستاره‌ی طلایی", group: "star" },
  { id: "star-blue", label: "ستاره‌ی آبی", group: "star" },
  { id: "star-rose", label: "ستاره‌ی صورتی", group: "star" },
  { id: "tg-crown", label: "تاج", group: "tg" },
  { id: "tg-diamond", label: "الماس", group: "tg" },
  { id: "tg-flame", label: "شعله", group: "tg" },
  { id: "tg-bolt", label: "صاعقه", group: "tg" },
  { id: "tg-rocket", label: "موشک", group: "tg" },
  { id: "ig-heart", label: "قلب رنگین‌کمانی", group: "ig" },
  { id: "ig-spark", label: "درخشش", group: "ig" },
  { id: "ig-ring", label: "حلقه‌ی گرادیان", group: "ig" },
  { id: "ig-camera", label: "دوربین", group: "ig" },
] as const;

export const MAX_BADGES = 6;
const IDS = new Set(BADGES.map((b) => b.id));

export function isBadgeId(x: unknown): x is string {
  return typeof x === "string" && IDS.has(x);
}

/** keeps known ids only, no duplicates, original order, at most MAX_BADGES */
export function cleanBadges(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (isBadgeId(v) && !out.includes(v)) out.push(v);
  return out.slice(0, MAX_BADGES);
}
