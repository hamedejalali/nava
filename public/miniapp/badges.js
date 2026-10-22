/* نوا گرام — badges: original SVG artwork (same ids as src/config/badges.ts) drawn next to a name, plus the verification tick.
   The blue tick = the `verified` flag. Any `tick-*` badge is a coloured tick of its own. All art here is drawn for Nava (no brand logos). */
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
    "star-gold": ic(star("url(#nbGold)", "#b9780a")),
    "star-blue": ic(star("url(#nbBlue)", "#1559b3")),
    "star-rose": ic(star("url(#nbRose)", "#a8195f")),
    "tg-crown": ic('<path d="M2.8 7.6 7.7 11.6 12 4.2l4.3 7.4 4.9-4L19.4 19H4.6Z" fill="url(#nbGold)" stroke="#b9780a" stroke-width=".8" stroke-linejoin="round"/><path d="M4.4 19.2h15.2v2.3H4.4Z" fill="url(#nbGoldD)" stroke="#b9780a" stroke-width=".6"/><circle cx="12" cy="4" r="1.5" fill="#ff5a6e" stroke="#b9780a" stroke-width=".5"/><circle cx="2.8" cy="7.4" r="1.3" fill="#3ec6ff"/><circle cx="21.2" cy="7.4" r="1.3" fill="#3ec6ff"/><circle cx="12" cy="14.2" r="1.7" fill="#ff5a6e" stroke="#fff" stroke-opacity=".6" stroke-width=".5"/><path d="M5.6 17.6 4.9 10.6 7.8 13Z" fill="#fff" fill-opacity=".5"/>' + gloss()),
    "tg-diamond": ic('<path d="M6.6 3.4h10.8L22 9.4 12 21.4 2 9.4Z" fill="url(#nbCyan)" stroke="#1473c9" stroke-width=".8" stroke-linejoin="round"/><path d="M2 9.4h20M9.2 3.4 7.2 9.4 12 21.4M14.8 3.4l2 6L12 21.4" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1" stroke-linejoin="round"/><path d="M7.4 4.6h4l-1.6 4.2H5Z" fill="#fff" fill-opacity=".55"/>'),
    "tg-flame": ic('<path d="M12.6 1.6c.8 3.4-.9 5.2-2.7 7.1C8.3 10.4 6.6 12.2 6.6 15a5.5 5.5 0 0 0 5.4 5.9 5.5 5.5 0 0 0 5.5-5.8c0-2.3-1.1-3.9-2.2-5.2 0 1.5-.5 2.6-1.4 3.2.6-3.5-.1-8-1.3-11.5Z" fill="url(#nbFlame)" stroke="#c8260f" stroke-width=".7" stroke-linejoin="round"/><path d="M12 22.4a3.7 3.7 0 0 0 3.7-3.8c0-1.7-1.7-3-3.7-5-2 2-3.7 3.3-3.7 5A3.7 3.7 0 0 0 12 22.4Z" fill="#ffd966"/><path d="M12 21.2a2 2 0 0 0 2-2c0-.9-.9-1.6-2-2.7-1.1 1.1-2 1.8-2 2.700a2 2 0 0 0 2 2Z" fill="#fff3b0"/>' + gloss()),
    "tg-bolt": ic('<path d="M14 1.4 4 13.6h6.2l-1.4 9 10.6-12.8h-6.6Z" fill="url(#nbGold)" stroke="#b9780a" stroke-width=".8" stroke-linejoin="round"/><path d="M13.2 3.6 6.8 12.2h4l.5-3.6Z" fill="#fff" fill-opacity=".55"/>'),
    "tg-rocket": ic('<path d="M12 1.6c3.9 2.4 6 6.4 5.3 11.6l-2.4 2.4H9.1l-2.4-2.4C6 8 8.100 4 12 1.6Z" fill="url(#nbSilver)" stroke="#8a97a8" stroke-width=".7"/><circle cx="12" cy="9.4" r="2.4" fill="url(#nbBlue)" stroke="#fff" stroke-width=".9"/><path d="M6.8 12.2 3.6 16l4-.6ZM17.2 12.2l3.2 3.800-4-.6Z" fill="#ff4d5e" stroke="#c42237" stroke-width=".5"/><path d="M9.6 16.2h4.800L12 22.2Z" fill="url(#nbFlame)"/><path d="M9.300 4.800c.8-1.100 1.700-1.800 2.400-2.200-1.600 2.300-2.300 5-2.100 8Z" fill="#fff" fill-opacity=".7"/>'),
    "ig-heart": ic('<path d="M12 21.4S3.2 16 3.2 9.7A5 5 0 0 1 12 7a5 5 0 0 1 8.800 2.700C20.800 16 12 21.400 12 21.400Z" fill="url(#nbIg)" stroke="#8d1f66" stroke-width=".7" stroke-linejoin="round"/><path d="M6 9.400c.2-1.800 1.600-2.700 3-2.500-1.700.5-2.700 1.600-3 2.500Z" fill="#fff" fill-opacity=".8"/>'),
    "ig-spark": ic('<path d="M12 1.4c.8 5.400 2.800 7.800 8.600 10.600-5.800 2.800-7.800 5.200-8.600 10.600-.8-5.400-2.800-7.800-8.600-10.600C9.200 9.200 11.200 6.800 12 1.400Z" fill="url(#nbIg)" stroke="#8d1f66" stroke-width=".7" stroke-linejoin="round"/><path d="M11.200 5.200c-.4 2.600-1.300 4-3.200 5.200 1.500-.5 2.600-1.700 3.200-5.200Z" fill="#fff" fill-opacity=".75"/>'),
    "ig-ring": ic('<circle cx="12" cy="12" r="8.600" fill="none" stroke="url(#nbIg)" stroke-width="3.200"/><circle cx="12" cy="12" r="3.400" fill="url(#nbIg)"/><path d="M5.800 8.600A7.200 7.200 0 0 1 10 5.200" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.300" stroke-linecap="round"/>'),
    "ig-camera": ic('<rect x="2.400" y="5.400" width="19.200" height="15" rx="4.600" fill="url(#nbIg)" stroke="#8d1f66" stroke-width=".7"/><circle cx="12" cy="12.900" r="4" fill="#fff" fill-opacity=".92"/><circle cx="12" cy="12.900" r="2.400" fill="url(#nbIg)"/><circle cx="17.600" cy="9" r="1.200" fill="#fff"/><path d="M5 8.200c.8-1 1.800-1.400 3-1.400" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.100" stroke-linecap="round"/>')
  };
  NG.BADGE_ART = ART;
  var LABEL = { "tick-gold": "تیک طلایی", "tick-green": "تیک سبز", "tick-purple": "تیک بنفش", "tick-red": "تیک قرمز", "tick-black": "تیک مشکی", "star-gold": "ستاره‌ی طلایی", "star-blue": "ستاره‌ی آبی", "star-rose": "ستاره‌ی صورتی", "tg-crown": "تاج", "tg-diamond": "الماس", "tg-flame": "شعله", "tg-bolt": "صاعقه", "tg-rocket": "موشک", "ig-heart": "قلب رنگین‌کمانی", "ig-spark": "درخشش", "ig-ring": "حلقه‌ی گرادیان", "ig-camera": "دوربین" };
  NG.BADGE_LABEL = LABEL;
  NG.BADGE_IDS = Object.keys(ART);

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
    if (tickId) h += ART[tickId]; else if (u.verified) h += DEFAULT_TICK;
    if (u.verified && u.gold) h += '<span class="goldc" title="Nava">🪙</span>';
    rest.forEach(function (id) { h += '<span class="bdw" title="' + (LABEL[id] || "") + '">' + ART[id] + "</span>"; });
    return h;
  };
})();
