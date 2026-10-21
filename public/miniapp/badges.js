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
  var ART = {
    "tick-gold": tick("url(#nbGold)"),
    "tick-green": tick("#1fbf5b"),
    "tick-purple": tick("url(#nbPurple)"),
    "tick-red": tick("#ff3040"),
    "tick-black": tick("#161616", "#9a9a9a"),
    "star-gold": ic('<path d="m12 2.2 2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.1l6.6-.9Z" fill="url(#nbGold)"/>'),
    "star-blue": ic('<path d="m12 2.2 2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.1l6.6-.9Z" fill="url(#nbBlue)"/>'),
    "star-rose": ic('<path d="m12 2.2 2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.1l6.6-.9Z" fill="url(#nbRose)"/>'),
    "tg-crown": ic('<path d="M3 8.5 7.6 12 12 5l4.4 7L21 8.5 19.2 19H4.8Z" fill="url(#nbGold)"/><rect x="5" y="19.6" width="14" height="1.8" rx=".9" fill="#c98a00"/>'),
    "tg-diamond": ic('<path d="M6.5 3.5h11L22 9.6 12 21 2 9.6Z" fill="url(#nbCyan)"/><path d="M2 9.6h20M9 3.5 7.4 9.6 12 21l4.6-11.4L15 3.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.1" stroke-linejoin="round"/>'),
    "tg-flame": ic('<path d="M12.4 2c.5 3-1.2 4.6-2.6 6.3C8.4 10 7 11.6 7 14.2A5 5 0 0 0 12 19.5a5 5 0 0 0 5-5.3c0-2-1-3.4-1.9-4.6.1 1.4-.4 2.3-1.2 2.9.5-3.1-.2-7.4-1.5-10.5Z" fill="url(#nbFlame)"/><path d="M12 22a3.4 3.4 0 0 0 3.4-3.5c0-1.5-1.6-2.7-3.4-4.5-1.8 1.8-3.4 3-3.4 4.5A3.4 3.4 0 0 0 12 22Z" fill="#ffd45a"/>'),
    "tg-bolt": ic('<path d="M13.6 1.8 4.4 13.4h6l-1.2 8.8 10.4-12.4h-6.3Z" fill="url(#nbGold)"/>'),
    "tg-rocket": ic('<path d="M12 2c3.6 2.2 5.6 6 5 11l-2.2 2.2H9.2L7 13c-.6-5 1.4-8.8 5-11Z" fill="#e9eef5"/><circle cx="12" cy="9.4" r="2.2" fill="#2e8bff"/><path d="m7.4 12.4-3 3.4 3.6-.4ZM16.6 12.4l3 3.4-3.6-.4Z" fill="#ff4d5e"/><path d="M10 16.4h4L12 21.6Z" fill="url(#nbFlame)"/>'),
    "ig-heart": ic('<path d="M12 21s-8.5-5.2-8.5-11.2A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 8.5 2.6C20.5 15.8 12 21 12 21Z" fill="url(#nbIg)"/>'),
    "ig-spark": ic('<path d="M12 1.8c.7 5.2 2.6 7.5 8.2 10.2-5.6 2.7-7.5 5-8.2 10.2-.7-5.2-2.6-7.5-8.2-10.2C9.4 9.3 11.3 7 12 1.8Z" fill="url(#nbIg)"/>'),
    "ig-ring": ic('<circle cx="12" cy="12" r="8.6" fill="none" stroke="url(#nbIg)" stroke-width="3"/><circle cx="12" cy="12" r="3.2" fill="url(#nbIg)"/>'),
    "ig-camera": ic('<rect x="2.6" y="5.6" width="18.8" height="14.6" rx="4.4" fill="none" stroke="url(#nbIg)" stroke-width="2.2"/><circle cx="12" cy="12.9" r="3.7" fill="none" stroke="url(#nbIg)" stroke-width="2.2"/><circle cx="17.4" cy="9.3" r="1.2" fill="url(#nbIg)"/>')
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
    lg("nbGold", ["#ffe27a", "#f5b301", "#d98a00"]) + lg("nbPurple", ["#b583ff", "#7a35e8"]) + lg("nbBlue", ["#6ec6ff", "#1f7ae0"]) +
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
