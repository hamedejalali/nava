/* مویاگرام — badges: original SVG artwork (same ids as src/config/badges.ts) drawn next to a name, plus the verification tick.
   The blue tick = the `verified` flag. Any `tick-*` badge is a coloured tick of its own. All art here is drawn for Moya (no brand logos). */
(function () {
  "use strict";
  var NG = window.NG;
  var SCALLOP = "M19.998 3.094 14.638 0l-2.972 5.15H5.432v6.354L0 14.64 3.094 20 0 25.359l5.432 3.137v5.905h5.975L14.638 40l5.36-3.094L25.358 40l3.232-5.6h6.162v-6.01L40 25.359 36.905 20 40 14.641l-5.248-3.03v-6.46h-6.419L25.358 0l-5.36 3.094Z";
  var CHECK = "M28.452 14.97 17.4 26.02l-5.47-5.47";
  function tick(fill, stroke) {
    return '<svg class="verified" viewBox="0 0 40 40" aria-label="verified"><path d="' + SCALLOP + '" fill="' + fill + '"' + (stroke ? ' stroke="' + stroke + '" stroke-width="1.6"' : "") + '/><path d="' + CHECK + '" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function ic(inner) { return '<svg class="bdg" viewBox="0 0 24 24" aria-hidden="true">' + inner + "</svg>"; }
  function gloss() { return ""; }
  function star(fill, edge) { return '<path d="m12 1.8 3 6.100 6.700.9-4.900 4.700 1.200 6.700-6-3.200-6 3.200 1.200-6.700L2.300 8.800l6.700-.9Z" fill="' + fill + '" stroke="' + edge + '" stroke-width=".8" stroke-linejoin="round"/><path d="m12 4.600 1.600 3.500-.9.2c-1.600.2-2.800.9-3.700 2.100L7 9.900Z" fill="#fff" fill-opacity=".55"/>'; }
  var ART = {
    "tick-gold": tick("url(#nbGold)"),
    "tick-green": tick("#1fbf5b"),
    "tick-purple": tick("url(#nbPurple)"),
    "tick-red": tick("#ff3040"),
    "tick-black": tick("#161616", "#9a9a9a"),
  };
  NG.BADGE_ART = ART;
  var LABEL = { "tick-gold": "تیک طلایی", "tick-green": "تیک سبز", "tick-purple": "تیک بنفش", "tick-red": "تیک قرمز", "tick-black": "تیک مشکی", "star-gold": "ستاره‌ی طلایی", "star-blue": "ستاره‌ی آبی", "star-rose": "ستاره‌ی صورتی", "tg-crown": "تاج", "tg-diamond": "الماس", "tg-flame": "شعله", "tg-bolt": "صاعقه", "tg-rocket": "موشک", "ig-heart": "قلب رنگین‌کمانی", "ig-spark": "درخشش", "ig-ring": "حلقه‌ی گرادیان", "ig-camera": "دوربین" };
  NG.BADGE_LABEL = LABEL;


  /* v1.28.2 badges: abstract 3D emblems (tools/build-badges.mjs → badges/<id>.svg), shown as images */
  var EM = {"gold": "شش‌ضلعی طلایی", "silver": "مدال نقره‌ای", "bronze": "مدال برنزی", "ruby": "یاقوت", "sapphire": "یاقوت کبود", "emerald": "زمرد", "amethyst": "سپر آمتیست", "obsidian": "ابسیدین", "aqua": "فیروزه", "rose": "درخشش صورتی", "sun": "خورشید", "royal": "سپر سلطنتی", "orbit": "ستاره‌ی هشت‌پر", "rank": "رتبه", "prism": "منشور"};
  Object.keys(EM).forEach(function (k) { ART["m-" + k] = '<img class="bdg bdi" src="badges/m-' + k + '.svg" alt="" draggable="false" decoding="async">'; LABEL["m-" + k] = EM[k]; });
  NG.BADGE_IDS = Object.keys(ART).filter(function (id) { return id.indexOf("tick-") === 0 || id.indexOf("m-") === 0; });

  /* shared gradient definitions (referenced by url(#id) from every badge) */
  var defs = document.createElement("div");
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  defs.setAttribute("aria-hidden", "true");
  function lg(id, stops) { return '<linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' + stops.map(function (s, i) { return '<stop offset="' + (i / (stops.length - 1)) + '" stop-color="' + s + '"/>'; }).join("") + "</linearGradient>"; }
  defs.innerHTML = '<svg width="0" height="0"><defs>' +
    lg("nbGold", ["#fff0a0", "#ffc61a", "#e08a00"]) + lg("nbGoldD", ["#ffd24a", "#c98a00"]) + lg("nbSilver", ["#ffffff", "#dfe6ef", "#a9b6c6"]) + lg("nbPurple", ["#b583ff", "#7a35e8"]) + lg("nbBlue", ["#6ec6ff", "#1f7ae0"]) +
    lg("nbRose", ["#ff9ac1", "#e8368f"]) + lg("nbCyan", ["#b6f3ff", "#32b8f0", "#1b78d6"]) + lg("nbFlame", ["#ffd45a", "#ff7a1a", "#e8341c"]) +
    '<linearGradient id="nbIg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".3" stop-color="#fa7e1e"/><stop offset=".55" stop-color="#d62976"/><stop offset=".8" stop-color="#962fbf"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient>' +
    "</defs></svg>";
  document.body.appendChild(defs);

  var DEFAULT_TICK = ART["tick-gold"] && '<svg class="verified" viewBox="0 0 40 40" aria-label="verified"><path d="' + SCALLOP + '" fill="#0095f6"/><path d="' + CHECK + '" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  NG.VERIFIED = DEFAULT_TICK;

  /** The tick + badges that follow a name. u = Brief/profile ({verified, gold, bd:[ids]}). */
  NG.vb = function (u) {
    if (!u) return "";
    var bd = Array.isArray(u.bd) ? u.bd : [];
    var tickId = null, rest = [];
    bd.forEach(function (id) { if (!ART[id]) return; if (id.indexOf("tick-") === 0) { if (!tickId) tickId = id; } else rest.push(id); });
    var h = "";
    // the official account (Moya) wears the gold tick; no coin / emoji next to it any more
    if (tickId) h += ART[tickId]; else if (u.verified && u.gold && ART["tick-gold"]) h += ART["tick-gold"]; else if (u.verified) h += DEFAULT_TICK;
    rest.forEach(function (id) { h += '<span class="bdw" title="' + (LABEL[id] || "") + '">' + ART[id] + "</span>"; });
    return h;
  };
})();
