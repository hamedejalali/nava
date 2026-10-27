/* Tiny helper library for tools/build-badges.mjs — original glossy vector badges (64×64), premium-emoji style.
   Every badge = gradient body + darker rim + soft specular highlight + drop shadow. Nothing here is copied from any emoji set. */
export const PAL = {
  gold: ["#fff6b0", "#ffc928", "#d98200"], goldD: ["#ffd55a", "#e0a000", "#a86400"], silver: ["#ffffff", "#dbe3ee", "#98a6b8"],
  red: ["#ff9a9a", "#f0293a", "#a80f24"], orange: ["#ffd27a", "#ff8a1f", "#d9480f"], yellow: ["#fffbb8", "#ffe23a", "#f0b400"],
  green: ["#c4f78a", "#3fc24a", "#13873a"], teal: ["#a6f7ea", "#21c4b0", "#0b7f86"], cyan: ["#c9f7ff", "#39c3f2", "#1479d4"],
  blue: ["#a8d4ff", "#3a86f0", "#1b47b8"], indigo: ["#c2c0ff", "#6a5cf0", "#3a2aa8"], purple: ["#e6bfff", "#a455f0", "#6a1fb8"],
  pink: ["#ffc9e0", "#ff5fa2", "#c71f6e"], brown: ["#e8b07a", "#a8622a", "#6b3512"], dark: ["#7a8190", "#30343d", "#0f1115"],
  white: ["#ffffff", "#f4f5fa", "#c3c9d6"], skin: ["#ffe6c2", "#f7bd7e", "#d98a3a"], gray: ["#d9dde6", "#a4abb8", "#6b7382"],
  lime: ["#eaff9a", "#a6e022", "#5b9a0c"], rose: ["#ffd0d8", "#ff7a93", "#c4304f"], sky: ["#e0f5ff", "#8fd3f7", "#3a8fd0"],
};
const fmt = (n) => (Math.round(n * 100) / 100).toString();

export function starPath(cx, cy, R, r, n, rot = -90) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = ((rot + (i * 180) / n) * Math.PI) / 180, rad = i % 2 ? r : R;
    pts.push(`${fmt(cx + rad * Math.cos(a))} ${fmt(cy + rad * Math.sin(a))}`);
  }
  return "M" + pts.join("L") + "Z";
}

/** build(k) → inner SVG markup. k offers gradient-aware primitives. Returns a complete standalone <svg>. */
export function make(id, build) {
  const used = new Set();
  const ref = (n) => { if (n[0] === "#") return n; used.add(n); return `url(#${id}-${n})`; };
  const dk = (n) => n[0] === "#" ? n : PAL[n.replace(/R$/, "")][PAL[n.replace(/R$/, "")].length - 1];
  const k = {
    f: ref, dk,
    /** filled path with a darker rim */
    P: (d, name, o = {}) => `<path d="${d}" fill="${ref(name)}" stroke="${o.sc ?? dk(name)}" stroke-width="${o.sw ?? 1.5}" stroke-linejoin="round" stroke-linecap="round"${o.eo ? ' fill-rule="evenodd"' : ""}${o.t ? ` transform="${o.t}"` : ""}${o.op ? ` opacity="${o.op}"` : ""}/>`,
    C: (cx, cy, r, name, o = {}) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ref(name)}" stroke="${o.sc ?? dk(name)}" stroke-width="${o.sw ?? 1.5}"${o.t ? ` transform="${o.t}"` : ""}/>`,
    E: (cx, cy, rx, ry, name, o = {}) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${ref(name)}" stroke="${o.sc ?? dk(name)}" stroke-width="${o.sw ?? 1.5}"${o.t ? ` transform="${o.t}"` : ""}/>`,
    R: (x, y, w, h, rx, name, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${ref(name)}" stroke="${o.sc ?? dk(name)}" stroke-width="${o.sw ?? 1.5}"${o.t ? ` transform="${o.t}"` : ""}/>`,
    /** plain colour shapes (eyes, pupils, lines …) */
    path: (d, fill, o = {}) => `<path d="${d}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1.5}" stroke-linecap="round" stroke-linejoin="round"` : ""}${o.op ? ` opacity="${o.op}"` : ""}${o.t ? ` transform="${o.t}"` : ""}/>`,
    line: (d, stroke, sw = 2, o = {}) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${o.op ? ` opacity="${o.op}"` : ""}${o.t ? ` transform="${o.t}"` : ""}/>`,
    dot: (cx, cy, r, fill, o = {}) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${o.op ? ` opacity="${o.op}"` : ""}/>`,
    /** specular highlight */
    G: (d, op = 0.55) => `<path d="${d}" fill="#fff" opacity="${op}"/>`,
    star: starPath,
  };
  const inner = build(k);
  const stops = (arr) => arr.map((c, i) => `<stop offset="${fmt(i / (arr.length - 1))}" stop-color="${c}"/>`).join("");
  const grads = [...used].map((n) => {
    const base = n.replace(/R$/, "");
    if (!PAL[base]) throw new Error(`badge ${id}: unknown colour ${n}`);
    return n.endsWith("R")
      ? `<radialGradient id="${id}-${n}" cx=".35" cy=".3" r=".85">${stops(PAL[base])}</radialGradient>`
      : `<linearGradient id="${id}-${n}" x1=".15" y1="0" x2=".85" y2="1">${stops(PAL[base])}</linearGradient>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs>${grads}<filter id="${id}-s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="#000" flood-opacity=".32"/></filter></defs><g filter="url(#${id}-s)">${inner}</g></svg>`;
}
