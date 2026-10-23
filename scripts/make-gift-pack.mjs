/* Builds gift-packs/starter-pack.zip — a ready pack of simple original Lottie gifts (pulse / spin / bounce …).
   Usage: node scripts/make-gift-pack.mjs   → then send the zip to the bot: admin → نوا گرام → هدیه‌ها → «📥 ایمپورت از فایل». */
import { zipSync, strToU8 } from "fflate";
import fs from "node:fs";

const kf = (frames, easing = true) => frames.map((f, i) => ({ t: f[0], s: f[1], ...(i < frames.length - 1 && easing ? { i: { x: [0.45], y: [1] }, o: { x: [0.55], y: [0] } } : {}) }));
const prop = (v) => (Array.isArray(v) && v.__kf ? { a: 1, k: v } : { a: 0, k: v });
const anim = (frames) => { const k = kf(frames.map(([t, v]) => [t, typeof v === "number" ? [v] : v])); k.__kf = true; return { a: 1, k }; };
const fill = (c, o = 100) => ({ ty: "fl", c: { a: 0, k: [...c, 1] }, o: { a: 0, k: o }, r: 1 });
const stroke = (c, w) => ({ ty: "st", c: { a: 0, k: [...c, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: w }, lc: 2, lj: 2 });
const grad = (stops) => ({ ty: "gf", o: { a: 0, k: 100 }, r: 1, s: { a: 0, k: [0, -120] }, e: { a: 0, k: [0, 130] }, t: 1, g: { p: stops.length, k: { a: 0, k: stops.flatMap(([o, r, g, b]) => [o, r, g, b]) } } });
const tr = () => ({ ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } });
const path = (v, i, o) => ({ ty: "sh", ks: { a: 0, k: { c: true, v, i, o } } });
const group = (items) => ({ ty: "gr", it: [...items, tr()], nm: "g" });
const layer = (ind, shapes, ks) => ({ ddd: 0, ind, ty: 4, nm: "l" + ind, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, ...ks }, ao: 0, shapes, ip: 0, op: 90, st: 0, bm: 0 });
const lottie = (nm, layers) => ({ v: "5.7.0", fr: 30, ip: 0, op: 90, w: 512, h: 512, nm, ddd: 0, assets: [], layers });

const star5 = (R, r) => { const v = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, rad = k % 2 ? r : R; v.push([Math.cos(a) * rad, Math.sin(a) * rad]); } return v; };
const zeros = (n) => Array.from({ length: n }, () => [0, 0]);
const poly = (v) => path(v, zeros(v.length), zeros(v.length));

/* heart: parametric curve sampled to a smooth polygon */
const heart = poly(Array.from({ length: 60 }, (_, k) => { const t = (k / 60) * Math.PI * 2; return [8.2 * 16 * Math.sin(t) ** 3, -8.2 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) + 10]; }));
const S = (a, b) => [a, b, 100];

const gifts = {
  heart: { name: "قلب تپنده", emoji: "❤️", price: 20, pattern: "💖", c1: "#ff8fb1", c2: "#c2185b",
    json: lottie("heart", [layer(1, [group([heart, grad([[0, 1, 0.55, 0.65], [1, 0.85, 0.1, 0.35]]), stroke([1, 0.8, 0.88], 6)])], { s: anim([[0, S(100, 100)], [15, S(118, 118)], [30, S(100, 100)], [45, S(118, 118)], [60, S(100, 100)], [90, S(100, 100)]]) })]) },
  star: { name: "ستاره‌ی چرخان", emoji: "⭐", price: 30, pattern: "✨", c1: "#ffe07a", c2: "#b27500",
    json: lottie("star", [layer(1, [group([poly(star5(130, 56)), grad([[0, 1, 0.92, 0.45], [1, 0.95, 0.62, 0.05]]), stroke([1, 0.97, 0.7], 6)])], { r: anim([[0, 0], [90, 360]]), s: anim([[0, S(100, 100)], [45, S(112, 112)], [90, S(100, 100)]]) })]) },
  diamond: { name: "الماس", emoji: "💎", price: 60, pattern: "💠", c1: "#8be0ff", c2: "#1a58b8",
    json: lottie("diamond", [layer(1, [group([poly([[-110, -50], [-60, -110], [60, -110], [110, -50], [0, 120]]), grad([[0, 0.75, 0.97, 1], [1, 0.15, 0.55, 0.9]]), stroke([0.85, 0.97, 1], 6)])], { s: anim([[0, S(100, 100)], [20, S(108, 92)], [45, S(94, 108)], [70, S(104, 98)], [90, S(100, 100)]]), r: anim([[0, -4], [45, 4], [90, -4]]) })]) },
  crown: { name: "تاج", emoji: "👑", price: 80, pattern: "👑", c1: "#ffd86b", c2: "#b27500",
    json: lottie("crown", [layer(1, [group([poly([[-125, 70], [-125, -50], [-60, 10], [0, -90], [60, 10], [125, -50], [125, 70]]), grad([[0, 1, 0.88, 0.35], [1, 0.9, 0.55, 0.05]]), stroke([1, 0.95, 0.6], 6)])], { p: anim([[0, [256, 256, 0]], [20, [256, 236, 0]], [40, [256, 256, 0]], [90, [256, 256, 0]]]) })]) },
  bolt: { name: "صاعقه", emoji: "⚡", price: 40, pattern: "⚡", c1: "#c9a0ff", c2: "#4a2fbd",
    json: lottie("bolt", [layer(1, [group([poly([[20, -130], [-85, 25], [-10, 25], [-30, 130], [85, -30], [8, -30]]), grad([[0, 1, 0.95, 0.4], [1, 1, 0.6, 0.05]]), stroke([1, 1, 0.8], 6)])], { r: anim([[0, -8], [10, 8], [20, -8], [30, 0], [90, 0]]), s: anim([[0, S(100, 100)], [10, S(112, 112)], [30, S(100, 100)], [90, S(100, 100)]]) })]) },
  ring: { name: "حلقه‌ی درخشان", emoji: "💍", price: 50, pattern: "💫", c1: "#ffb3d1", c2: "#7a35e8",
    json: lottie("ring", [layer(1, [group([{ ty: "el", p: { a: 0, k: [0, 20] }, s: { a: 0, k: [210, 210] } }, stroke([1, 0.84, 0.3], 28)]), group([poly([[0, -92], [-40, -132], [0, -178], [40, -132]]), grad([[0, 0.8, 0.98, 1], [1, 0.3, 0.6, 1]]), stroke([1, 1, 1], 4)])], { r: anim([[0, -6], [45, 6], [90, -6]]), s: anim([[0, S(100, 100)], [45, S(106, 106)], [90, S(100, 100)]]) })]) },
};

const files = {};
const list = [];
for (const [k, g] of Object.entries(gifts)) {
  files[`${k}.json`] = strToU8(JSON.stringify(g.json));
  list.push({ file: `${k}.json`, name: g.name, emoji: g.emoji, price: g.price, pattern: g.pattern, c1: g.c1, c2: g.c2 });
}
files["pack.json"] = strToU8(JSON.stringify({ gifts: list }, null, 2));
fs.mkdirSync("gift-packs", { recursive: true });
fs.writeFileSync("gift-packs/starter-pack.zip", zipSync(files));


console.log("ok", Object.keys(gifts).length);
