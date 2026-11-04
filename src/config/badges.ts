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
  group: "tick" | "emblem";
}

/** v1.28.2: the old emoji-style sets (stars / tg / ig / em-*) were removed. What remains: the coloured ticks and the abstract 3D emblems
 *  (public/miniapp/badges/<id>.svg, built by tools/build-badges.mjs from tools/badges-m.mjs). Ids stored on users that are no longer
 *  here are simply ignored (cleanBadges drops them on every read), so nothing broken is ever shown. */
export const BADGES: readonly BadgeDef[] = [
  { id: "tick-gold", label: "تیک طلایی", group: "tick" },
  { id: "tick-green", label: "تیک سبز", group: "tick" },
  { id: "tick-purple", label: "تیک بنفش", group: "tick" },
  { id: "tick-red", label: "تیک قرمز", group: "tick" },
  { id: "tick-black", label: "تیک مشکی", group: "tick" },
  { id: "m-gold", label: "شش‌ضلعی طلایی", group: "emblem" },
  { id: "m-silver", label: "مدال نقره‌ای", group: "emblem" },
  { id: "m-bronze", label: "مدال برنزی", group: "emblem" },
  { id: "m-ruby", label: "یاقوت", group: "emblem" },
  { id: "m-sapphire", label: "یاقوت کبود", group: "emblem" },
  { id: "m-emerald", label: "زمرد", group: "emblem" },
  { id: "m-amethyst", label: "سپر آمتیست", group: "emblem" },
  { id: "m-obsidian", label: "ابسیدین", group: "emblem" },
  { id: "m-aqua", label: "فیروزه", group: "emblem" },
  { id: "m-rose", label: "درخشش صورتی", group: "emblem" },
  { id: "m-sun", label: "خورشید", group: "emblem" },
  { id: "m-royal", label: "سپر سلطنتی", group: "emblem" },
  { id: "m-orbit", label: "ستاره‌ی هشت‌پر", group: "emblem" },
  { id: "m-rank", label: "رتبه", group: "emblem" },
  { id: "m-prism", label: "منشور", group: "emblem" },
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
