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
  group: "tick" | "star" | "tg" | "ig" | "em";
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
  // v1.24: emoji-style badges (Noto Color Emoji artwork in public/miniapp/emoji/)
  { id: "em-crown", label: "تاج", group: "em" },
  { id: "em-gem", label: "الماس", group: "em" },
  { id: "em-fire", label: "آتش", group: "em" },
  { id: "em-bolt", label: "صاعقه", group: "em" },
  { id: "em-rocket", label: "موشک", group: "em" },
  { id: "em-sparkles", label: "درخشش", group: "em" },
  { id: "em-star", label: "ستاره", group: "em" },
  { id: "em-star2", label: "ستاره‌ی درخشان", group: "em" },
  { id: "em-dizzy", label: "ستاره‌باران", group: "em" },
  { id: "em-heartfire", label: "قلب آتشین", group: "em" },
  { id: "em-sparkheart", label: "قلب درخشان", group: "em" },
  { id: "em-trophy", label: "جام", group: "em" },
  { id: "em-medal", label: "مدال", group: "em" },
  { id: "em-gold1", label: "رتبه‌ی یک", group: "em" },
  { id: "em-camera", label: "دوربین", group: "em" },
  { id: "em-rainbow", label: "رنگین‌کمان", group: "em" },
  { id: "em-unicorn", label: "اسب تک‌شاخ", group: "em" },
  { id: "em-crystal", label: "گوی جادویی", group: "em" },
  { id: "em-shield", label: "سپر", group: "em" },
  { id: "em-money", label: "کیسه‌ی طلا", group: "em" },
  { id: "em-gift", label: "هدیه", group: "em" },
  { id: "em-party", label: "جشن", group: "em" },
  { id: "em-clover", label: "شبدر", group: "em" },
  { id: "em-blossom", label: "شکوفه", group: "em" },
  { id: "em-butterfly", label: "پروانه", group: "em" },
  { id: "em-eagle", label: "عقاب", group: "em" },
  { id: "em-lion", label: "شیر", group: "em" },
  { id: "em-dragon", label: "اژدها", group: "em" },
  { id: "em-ring", label: "حلقه", group: "em" },
  { id: "em-hundred", label: "صد", group: "em" },
  { id: "em-rose", label: "رز", group: "em" },
  { id: "em-moon", label: "ماه", group: "em" },
  { id: "em-sun", label: "خورشید", group: "em" },
  { id: "em-alien", label: "فضایی", group: "em" },
  { id: "em-diamondblue", label: "الماس آبی", group: "em" },
  { id: "em-cool", label: "خفن", group: "em" },
  // v1.26: more emoji badges + the Nava coin
  { id: "em-navacoin", label: "سکه‌ی نوا", group: "em" },
  { id: "em-wolf", label: "گرگ", group: "em" },
  { id: "em-fox", label: "روباه", group: "em" },
  { id: "em-trident", label: "نیزه‌ی سه‌شاخ", group: "em" },
  { id: "em-swords", label: "شمشیرها", group: "em" },
  { id: "em-target", label: "هدف", group: "em" },
  { id: "em-masks", label: "نقاب", group: "em" },
  { id: "em-art", label: "پالت رنگ", group: "em" },
  { id: "em-mic", label: "میکروفون", group: "em" },
  { id: "em-headphones", label: "هدفون", group: "em" },
  { id: "em-gamepad", label: "گیم", group: "em" },
  { id: "em-heart", label: "قلب قرمز", group: "em" },
  { id: "em-blueheart", label: "قلب آبی", group: "em" },
  { id: "em-blackheart", label: "قلب مشکی", group: "em" },
  { id: "em-nazar", label: "چشم‌نظر", group: "em" },
  { id: "em-coffee", label: "قهوه", group: "em" },
  { id: "em-leopard", label: "پلنگ", group: "em" },
  { id: "em-dove", label: "کبوتر", group: "em" },
  { id: "em-eye", label: "چشم", group: "em" },
  { id: "em-tophat", label: "کلاه", group: "em" },
  { id: "em-key", label: "کلید", group: "em" },
  { id: "em-brain", label: "مغز", group: "em" },
  { id: "em-glowstar", label: "ستاره‌ی تابان", group: "em" },
  { id: "em-comet", label: "ستاره‌دنباله‌دار", group: "em" },
  { id: "em-ghost", label: "روح", group: "em" },
  { id: "em-skull", label: "جمجمه", group: "em" },
  { id: "em-cat", label: "گربه", group: "em" },
] as const;

export const MAX_BADGES = 8;
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
