/* v1.28.2 — the badge set: abstract 3D emblems (no emoji, no animals, no objects). Each = a faceted body in a metal / gem colour,
   a bevelled inner plate, a geometric centre mark and a soft gloss. The 3D lighting + drop shadow is added by badge-lib.make(). */
const f = (n) => Math.round(n * 100) / 100;
const poly = (n, r, rot = -90, cx = 32, cy = 32) => Array.from({ length: n }, (_, i) => { const a = ((rot + (360 / n) * i) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
const d = (pts) => "M" + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join("L") + "Z";
const circle = (r, cx = 32, cy = 32) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const SHIELD = (s = 1, cx = 32, cy = 32) => { const x = (v) => f(cx + (v - 32) * s), y = (v) => f(cy + (v - 32) * s); return `M${x(32)} ${y(5)}L${x(55)} ${y(13)}V${y(33)}C${x(55)} ${y(46)} ${x(45)} ${y(55)} ${x(32)} ${y(60)}C${x(19)} ${y(55)} ${x(9)} ${y(46)} ${x(9)} ${y(33)}V${y(13)}Z`; };
const RRECT = (s = 1) => { const a = f(32 - 26 * s), b = f(32 + 26 * s), r = f(11 * s); return `M${a + r} ${a}H${b - r}Q${b} ${a} ${b} ${a + r}V${b - r}Q${b} ${b} ${b - r} ${b}H${a + r}Q${a} ${b} ${a} ${b - r}V${a + r}Q${a} ${a} ${a + r} ${a}Z`; };

/** body + bevel plate + gloss. `plate` is the inner (lighter, radial) plate */
const base = (k, bodyD, plateD, name, o = {}) =>
  k.P(bodyD, name, { sw: 1.8 }) + k.P(plateD, name + "R", { sw: 1.1, sc: o.rim ?? "#ffffff80" }) +
  k.G("M14 22C17 13 25 8 34 7C26 11 20 17 18 27Z", 0.5);

const star = (k, fill, edge = "#00000040") => k.P(k.star(32, 33, 12.5, 5.4, 5), fill, { sw: 1, sc: edge }) + k.G("M32 22 L34.6 30 L28 29Z", 0.55);
const diamondMark = (k, fill) => k.P(d(poly(4, 11, -90, 32, 32)), fill, { sw: 1, sc: "#00000030" }) + k.line("M21 32H43M32 21V43", "#ffffff", 1, { op: 0.55 });
const chevrons = (k, fill) => k.line("M22 24L32 31L42 24", fill, 4) + k.line("M22 33L32 40L42 33", fill, 4, { op: 0.85 }) + k.line("M22 42L32 49L42 42", fill, 4, { op: 0.6 });
const ringMark = (k, fill) => k.C(32, 32, 9, "#00000000", { sw: 4, sc: fill }) + k.dot(32, 32, 3.2, fill);
const sparkMark = (k, fill) => k.path("M32 19C33 27 37 31 45 32C37 33 33 37 32 45C31 37 27 33 19 32C27 31 31 27 32 19Z", fill, { stroke: "#00000030", sw: 0.8 });
const orbit = (k, fill) => k.P(d(poly(4, 12, -90, 32, 32)), fill, { sw: 0.8, sc: "#00000030" }) + k.P(d(poly(4, 12, -45, 32, 32)), fill, { sw: 0.8, sc: "#00000030" }) + k.dot(32, 32, 3.6, "#1479d4");
const bars = (k, fill) => k.R(21, 38, 6, 10, 1.5, "#ffffff", { sw: 0.8, sc: "#00000030" }) + k.R(29, 30, 6, 18, 1.5, "#ffffff", { sw: 0.8, sc: "#00000030" }) + k.R(37, 22, 6, 26, 1.5, "#ffffff", { sw: 0.8, sc: "#00000030" });
const prism = (k) => k.P("M32 15L47 45H17Z", "white", { sw: 1, sc: "#00000030" }) + k.path("M32 25L40 41H24Z", "#3a8fd0", { op: 0.8 }) + k.path("M32 15L47 45H32Z", "#00000018");

export default {
  "m-gold": (k) => base(k, d(poly(6, 27)), d(poly(6, 21.5)), "gold") + star(k, "white", "#a86400"),
  "m-silver": (k) => base(k, circle(27), circle(21.5), "silver", { rim: "#ffffffc0" }) + star(k, "#7d8aa0", "#4d5a70"),
  "m-bronze": (k) => base(k, circle(27), circle(21.5), "brown") + star(k, "gold", "#6b3512"),
  "m-ruby": (k) => base(k, d(poly(4, 29)), d(poly(4, 22)), "red") + k.line("M32 10V54M10 32H54", "#ffffff", 1, { op: 0.35 }) + diamondMark(k, "white"),
  "m-sapphire": (k) => base(k, d(poly(8, 27, -67.5)), d(poly(8, 21, -67.5)), "blue") + k.line("M32 11L32 53M11 32H53M17 17L47 47M47 17L17 47", "#ffffff", 0.9, { op: 0.28 }) + diamondMark(k, "cyan"),
  "m-emerald": (k) => base(k, d(poly(8, 27, -67.5)), d(poly(8, 21, -67.5)), "green") + k.line("M32 11L32 53M11 32H53", "#ffffff", 0.9, { op: 0.3 }) + diamondMark(k, "lime"),
  "m-amethyst": (k) => base(k, SHIELD(1), SHIELD(0.78), "purple") + chevrons(k, "#ffffff"),
  "m-obsidian": (k) => base(k, d(poly(6, 27)), d(poly(6, 21.5)), "dark", { rim: "#ffd55a" }) + ringMark(k, "#ffd55a"),
  "m-aqua": (k) => base(k, RRECT(1), RRECT(0.78), "teal") + ringMark(k, "#ffffff"),
  "m-rose": (k) => base(k, circle(27), circle(21.5), "pink") + sparkMark(k, "#ffffff"),
  "m-sun": (k) => base(k, circle(27), circle(21.5), "orange") + k.C(32, 32, 9.5, "yellow", { sw: 1.2 }) + k.C(32, 32, 14.5, "#00000000", { sw: 1, sc: "#ffffffaa" }),
  "m-royal": (k) => base(k, SHIELD(1), SHIELD(0.78), "indigo") + star(k, "gold", "#a86400"),
  "m-orbit": (k) => base(k, d(poly(6, 27)), d(poly(6, 21.5)), "cyan") + orbit(k, "#ffffff"),
  "m-rank": (k) => base(k, RRECT(1), RRECT(0.78), "goldD") + bars(k),
  "m-prism": (k) => base(k, circle(27), circle(21.5), "sky") + prism(k),
};
