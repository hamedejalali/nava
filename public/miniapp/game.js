/* مویاگرام — بازی‌ها (v1.25): صفحه‌ی «بازی‌ها»، دکمه‌ی شناور، لابی و تخته‌ی تخته‌نرد.
   The server (api/miniapp.ts game_* actions) owns every rule and every clock; this file only draws the board, the 3D dice and
   the animations, and sends taps. Board: SVG, tap a checker, then a glowing point. The board is turned 180° for the black player,
   so everybody's home is bottom-right. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  /* ------------------------------------------------------------------ geometry (SVG units) */
  var W = 396, H = 324, F = 16, PW = 25, PH = 128, BARX = 178, FLIP = 356; // FLIP = 16 + 340: mirrors the playing field for black
  var TRX = 346, TRW = 34; // the "borne off" trays on the right edge
  var FACE = { 1: [0, 0], 6: [180, 0], 3: [-90, 0], 4: [90, 0], 2: [0, -90], 5: [0, 90] }; // [rotateY, rotateX] that bring a face to the front
  var openBoards = {}; // gid → true while its board is on screen

  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function p2(n) { return (n < 10 ? "۰" : "") + num(n); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return num(Math.floor(s / 60)) + ":" + p2(s % 60); }

  function colX(col) { return col < 6 ? F + col * PW + PW / 2 : 190 + (col - 6) * PW + PW / 2; }
  /** where point pt sits for the viewer `me` → {x, top} */
  function place(pt, me) {
    var top, col;
    if (pt >= 13) { top = true; col = pt - 13; } else { top = false; col = 12 - pt; }
    var x = colX(col);
    if (me === 1) { x = FLIP - x; top = !top; }
    return { x: x, top: top };
  }
  function spacing(n) { return n <= 5 ? 23 : (PH - 26) / (n - 1); }
  function ckPos(pt, i, n, me) { var p = place(pt, me); return { x: p.x, y: p.top ? 16 + 11.5 + i * spacing(n) : 308 - 11.5 - i * spacing(n) }; }
  function barPos(who, i, me) { return { x: BARX, y: who === me ? 308 - 14 - i * 22 : 16 + 14 + i * 22 }; }
  function trayPos(who, i, me) { return { x: TRX + TRW / 2, y: who === me ? 303 - i * 7 : 50 + i * 7 }; }

  /* ------------------------------------------------------------------ the board drawing */
  var DEFS = '<defs>' +
    '<linearGradient id="gwd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8d5226"/><stop offset=".5" stop-color="#683819"/><stop offset="1" stop-color="#46240f"/></linearGradient>' +
    '<linearGradient id="gwl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a4421"/><stop offset=".5" stop-color="#a8703d"/><stop offset="1" stop-color="#6f3d1c"/></linearGradient>' +
    '<linearGradient id="gfl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21805a"/><stop offset="1" stop-color="#12523a"/></linearGradient>' +
    '<linearGradient id="ggA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d58c"/><stop offset="1" stop-color="#b78737"/></linearGradient>' +
    '<linearGradient id="ggB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f4d58c"/><stop offset="1" stop-color="#b78737"/></linearGradient>' +
    '<linearGradient id="grA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4493f"/><stop offset="1" stop-color="#7a1c18"/></linearGradient>' +
    '<linearGradient id="grB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#c4493f"/><stop offset="1" stop-color="#7a1c18"/></linearGradient>' +
    '<linearGradient id="gbev" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient>' +
    '<radialGradient id="gstud" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff3c4"/><stop offset=".5" stop-color="#d9a73f"/><stop offset="1" stop-color="#7a5314"/></radialGradient>' +
    '<radialGradient id="gcw1" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#fffdf2"/><stop offset=".7" stop-color="#e6d8b6"/><stop offset="1" stop-color="#bba77a"/></radialGradient>' +
    '<radialGradient id="gcw2" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#f7eed6"/><stop offset="1" stop-color="#dccdaa"/></radialGradient>' +
    '<radialGradient id="gcb1" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#6d6a76"/><stop offset=".7" stop-color="#26242b"/><stop offset="1" stop-color="#0a090d"/></radialGradient>' +
    '<radialGradient id="gcb2" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#34323b"/><stop offset="1" stop-color="#16141a"/></radialGradient>' +
    '<filter id="fgr" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.42" numOctaves="3" seed="3"/><feColorMatrix type="matrix" values="0 0 0 0 .2  0 0 0 0 .09  0 0 0 0 .03  2.3 0 0 0 -.9"/></filter>' +
    '<filter id="fgl" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.01 0.5" numOctaves="2" seed="11"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 .82  0 0 0 0 .55  2.1 0 0 0 -1.05"/></filter>' +
    '<filter id="ffl" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="5"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 .1  0 0 0 0 .04  1.3 0 0 0 -.5"/></filter>' +
    '<filter id="fin" x="-4%" y="-4%" width="108%" height="108%"><feOffset in="SourceAlpha" dy="2"/><feGaussianBlur stdDeviation="3" result="b"/><feComposite operator="arithmetic" k2="-1" k3="1" in="SourceAlpha" in2="b" result="inv"/><feFlood flood-color="#000" flood-opacity=".65"/><feComposite in2="inv" operator="in" result="sh"/><feComposite in="sh" in2="SourceAlpha" operator="in" result="sh2"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="sh2"/></feMerge></filter>' +
    '<filter id="fsh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>' +
    '<pattern id="pcv" width="16" height="8" patternUnits="userSpaceOnUse"><path d="M8 .8 13.4 4 8 7.2 2.6 4Z" fill="#d4a45a" stroke="#3a1c0a" stroke-width=".7"/><path d="M8 2.4 10.8 4 8 5.6 5.2 4Z" fill="#3a1c0a" opacity=".75"/><circle cx="0" cy="4" r="1" fill="#3a1c0a" opacity=".6"/><circle cx="16" cy="4" r="1" fill="#3a1c0a" opacity=".6"/></pattern>' +
    '<pattern id="pcvv" width="16" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(90)"><path d="M8 .8 13.4 4 8 7.2 2.6 4Z" fill="#d4a45a" stroke="#3a1c0a" stroke-width=".7"/><path d="M8 2.4 10.8 4 8 5.6 5.2 4Z" fill="#3a1c0a" opacity=".75"/><circle cx="0" cy="4" r="1" fill="#3a1c0a" opacity=".6"/><circle cx="16" cy="4" r="1" fill="#3a1c0a" opacity=".6"/></pattern>' +
    '<g id="rose"><g fill="#d9aa5e" stroke="#3a1c0a" stroke-width=".6"><ellipse rx="6" ry="2.1"/><ellipse rx="6" ry="2.1" transform="rotate(45)"/><ellipse rx="6" ry="2.1" transform="rotate(90)"/><ellipse rx="6" ry="2.1" transform="rotate(135)"/></g><circle r="2.2" fill="#3a1c0a"/><circle r="1" fill="#e8c27a"/></g>' +
    '<g id="ckw"><circle cx="1.4" cy="2.6" r="11" fill="#000" opacity=".4"/><circle r="11" fill="url(#gcw1)" stroke="#7d6a45" stroke-width=".9"/><circle r="8.5" fill="none" stroke="#b3a27a" stroke-width="1.3"/><circle r="6" fill="url(#gcw2)"/><path d="M-8.2 -4.2A9.3 9.3 0 0 1 2 -9.1" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.6" stroke-linecap="round"/></g>' +
    '<g id="ckb"><circle cx="1.4" cy="2.6" r="11" fill="#000" opacity=".45"/><circle r="11" fill="url(#gcb1)" stroke="#000" stroke-width=".9"/><circle r="8.5" fill="none" stroke="#4f4c58" stroke-width="1.3"/><circle r="6" fill="url(#gcb2)"/><path d="M-8.2 -4.2A9.3 9.3 0 0 1 2 -9.1" fill="none" stroke="#fff" stroke-opacity=".38" stroke-width="1.6" stroke-linecap="round"/></g>' +
    '</defs>';

  /** o: { sel, targets:[{to,hit}], movable:[from], lastTo, skip:{pt}|{off:who}, popBar:who, dropOff:who } */
  function boardSvg(v, o) {
    var me = v.me, st = v.state, s = [], i, pt;
    o = o || {};
    s.push('<svg class="gmsvg" viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">' + DEFS);
    // thick carved wooden frame
    s.push('<rect width="' + W + '" height="' + H + '" rx="20" fill="url(#gwd)"/><rect width="' + W + '" height="' + H + '" rx="20" filter="url(#fgr)" opacity=".62"/><rect width="' + W + '" height="' + H + '" rx="20" filter="url(#fgl)" opacity=".16"/>');
    s.push('<rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" rx="19" fill="none" stroke="url(#gbev)" stroke-width="2"/>');
    s.push('<rect x="22" y="4" width="' + (W - 44) + '" height="8" fill="url(#pcv)"/><rect x="22" y="' + (H - 12) + '" width="' + (W - 44) + '" height="8" fill="url(#pcv)"/>');
    s.push('<rect x="4" y="22" width="8" height="' + (H - 44) + '" fill="url(#pcvv)"/><rect x="' + (W - 12) + '" y="22" width="8" height="' + (H - 44) + '" fill="url(#pcvv)"/>');
    [[9, 9], [W - 9, 9], [9, H - 9], [W - 9, H - 9]].forEach(function (c) { s.push('<use href="#rose" x="' + c[0] + '" y="' + c[1] + '"/>'); });
    s.push('<rect x="14.4" y="14.4" width="' + (W - 28.8) + '" height="' + (H - 28.8) + '" rx="3" fill="none" stroke="#e3b663" stroke-opacity=".85" stroke-width="1"/><rect x="15.6" y="15.6" width="' + (W - 31.2) + '" height="' + (H - 31.2) + '" rx="2" fill="none" stroke="#2a1306" stroke-opacity=".8" stroke-width="1"/>');
    // the two felt halves
    s.push('<g filter="url(#fin)"><rect x="16" y="16" width="150" height="292" fill="url(#gfl)"/><rect x="190" y="16" width="150" height="292" fill="url(#gfl)"/></g>');
    s.push('<rect x="16" y="16" width="150" height="292" filter="url(#ffl)" opacity=".4"/><rect x="190" y="16" width="150" height="292" filter="url(#ffl)" opacity=".4"/>');
    // the middle bar, with a carved vine and brass studs
    s.push('<rect x="166" y="16" width="24" height="292" fill="url(#gwl)"/><rect x="166" y="16" width="24" height="292" filter="url(#fgr)" opacity=".5"/><rect x="174" y="24" width="8" height="276" fill="url(#pcvv)"/><rect x="166" y="16" width="24" height="292" fill="none" stroke="#2a1306" stroke-opacity=".7"/>');
    [60, 162, 264].forEach(function (y) { s.push('<circle cx="178" cy="' + y + '" r="5.4" fill="url(#gstud)" stroke="#3a1c0a" stroke-width=".8"/><circle cx="176.6" cy="' + (y - 1.4) + '" r="1.5" fill="#fff" opacity=".7"/>'); });
    // the trays for borne-off checkers
    [[16, 140], [168, 140]].forEach(function (t) {
      s.push('<g filter="url(#fin)"><rect x="' + TRX + '" y="' + t[0] + '" width="' + TRW + '" height="' + t[1] + '" rx="4" fill="#2b170a"/></g><rect x="' + TRX + '" y="' + t[0] + '" width="' + TRW + '" height="' + t[1] + '" rx="4" filter="url(#fgr)" opacity=".5"/><rect x="' + TRX + '" y="' + t[0] + '" width="' + TRW + '" height="' + t[1] + '" rx="4" fill="none" stroke="#d9aa5e" stroke-opacity=".5" stroke-width=".8"/>');
    });
    // triangles (the green / gold / red the players like)
    var targets = o.targets || [], tmap = {};
    targets.forEach(function (t) { tmap[String(t.to)] = t; });
    for (pt = 1; pt <= 24; pt++) {
      var p = place(pt, me), x0 = p.x - PW / 2, gold = pt % 2 === 0;
      var tip = p.top ? 16 + 118 : 308 - 118, base = p.top ? 16 : 308;
      s.push('<polygon points="' + x0 + "," + base + " " + (x0 + PW) + "," + base + " " + p.x + "," + tip + '" fill="url(#' + (gold ? "gg" : "gr") + (p.top ? "A" : "B") + ')" stroke="#00000040" stroke-width=".7"/>');
    }
    // checkers on the points
    var skipPt = o.skip && o.skip.pt;
    for (pt = 1; pt <= 24; pt++) {
      var n = st.points[pt - 1]; if (!n) continue;
      var who = n > 0 ? 0 : 1, c = Math.abs(n), shown = c;
      for (i = 0; i < shown; i++) {
        if (skipPt === pt && i === shown - 1) continue;
        var q = ckPos(pt, i, c, me);
        s.push('<use href="#ck' + (who === 0 ? "w" : "b") + '" x="' + q.x + '" y="' + q.y + '"' + (o.lastTo === pt && i === shown - 1 ? ' class="gmlast"' : "") + "/>");
      }
      if (c > 5) { var tq = ckPos(pt, c - 1, c, me); s.push('<text class="gmcnt" x="' + tq.x + '" y="' + (tq.y + 4) + '" text-anchor="middle" fill="' + (who === 0 ? "#2b2418" : "#fff") + '">' + num(c) + "</text>"); }
    }
    // the bar
    var opp = 1 - me, cnt = Math.min(st.bar[me], 4), cnt2 = Math.min(st.bar[opp], 4);
    for (i = 0; i < cnt; i++) { var b1 = barPos(me, i, me); s.push('<use href="#ck' + (me === 0 ? "w" : "b") + '" x="' + b1.x + '" y="' + b1.y + '"' + (o.popBar === me && i === cnt - 1 ? ' class="gmpop"' : "") + "/>"); }
    for (i = 0; i < cnt2; i++) { var b2 = barPos(opp, i, me); s.push('<use href="#ck' + (opp === 0 ? "w" : "b") + '" x="' + b2.x + '" y="' + b2.y + '"' + (o.popBar === opp && i === cnt2 - 1 ? ' class="gmpop"' : "") + "/>"); }
    if (st.bar[me] > 4) s.push('<text class="gmcnt" x="' + BARX + '" y="' + (barPos(me, 3, me).y + 4) + '" text-anchor="middle" fill="' + (me === 0 ? "#2b2418" : "#fff") + '">' + num(st.bar[me]) + "</text>");
    // borne off: flat checkers piled in the tray, a label above each pile
    [me, opp].forEach(function (who2) {
      var cn = st.off[who2], mine = who2 === me, ly = mine ? 168 : 16;
      for (var k = 0; k < cn; k++) {
        if (o.skip && o.skip.off === who2 && k === cn - 1) continue;
        var tp = trayPos(who2, k, me);
        s.push('<rect class="' + (o.dropOff === who2 && k === cn - 1 ? "gmdrop " : "") + '" x="' + (tp.x - 14) + '" y="' + (tp.y - 3) + '" width="28" height="6" rx="2.6" fill="' + (who2 === 0 ? "#efe6cc" : "#2a2830") + '" stroke="' + (who2 === 0 ? "#8a7550" : "#000") + '" stroke-opacity=".7" stroke-width=".7"/>');
      }
      s.push('<text x="' + (TRX + TRW / 2) + '" y="' + (ly + 13) + '" text-anchor="middle" class="gmtl">بیرون</text><text class="gmtn' + (o.dropOff === who2 ? " gmnpop" : "") + '" x="' + (TRX + TRW / 2) + '" y="' + (ly + 27) + '" text-anchor="middle">' + num(cn) + "/" + num(15) + "</text>");
    });
    // what I can do right now: glowing top checkers, glowing landing spots, the chosen checker
    (o.movable || []).forEach(function (f) {
      var q2;
      if (f === "bar") q2 = barPos(me, Math.max(0, cnt - 1), me);
      else { var c2 = Math.abs(st.points[f - 1]); q2 = ckPos(f, c2 - 1, c2, me); }
      s.push('<circle class="gmcan" cx="' + q2.x + '" cy="' + q2.y + '" r="13.2" fill="none" stroke="#ffe08a" stroke-width="1.8"/>');
    });
    if (o.sel != null) {
      var qs;
      if (o.sel === "bar") qs = barPos(me, Math.max(0, cnt - 1), me);
      else { var c3 = Math.abs(st.points[o.sel - 1]); qs = ckPos(o.sel, c3 - 1, c3, me); }
      s.push('<circle class="gmsel" cx="' + qs.x + '" cy="' + qs.y + '" r="14" fill="#ffd54a" fill-opacity=".18" stroke="#ffd54a" stroke-width="2.4"/>');
    }
    targets.forEach(function (t) {
      if (t.to === "off") { s.push('<rect class="gmtg" x="' + TRX + '" y="168" width="' + TRW + '" height="140" rx="4" fill="#2ecc71" fill-opacity=".28" stroke="#2ecc71" stroke-width="2"/>'); return; }
      var cn2 = Math.abs(st.points[t.to - 1]), mine2 = st.points[t.to - 1] !== 0 && ((st.points[t.to - 1] > 0) === (me === 0));
      var idx = t.hit ? 0 : (mine2 || cn2 === 0 ? cn2 : 0), qt = ckPos(t.to, idx, Math.max(cn2 + 1, 1), me);
      s.push('<circle class="gmtg" cx="' + qt.x + '" cy="' + qt.y + '" r="11.6" fill="' + (t.hit ? "#ff5a4d" : "#2ecc71") + '" fill-opacity=".26" stroke="' + (t.hit ? "#ff5a4d" : "#2ecc71") + '" stroke-width="2" stroke-dasharray="3.4 3"/>');
    });
    // tap areas LAST, so a checker never swallows a tap
    for (pt = 1; pt <= 24; pt++) { var pp = place(pt, me); s.push('<rect data-pt="' + pt + '" x="' + (pp.x - PW / 2) + '" y="' + (pp.top ? 16 : 308 - PH) + '" width="' + PW + '" height="' + PH + '" fill="transparent"/>'); }
    s.push('<rect data-pt="bar" x="166" y="16" width="24" height="292" fill="transparent"/><rect data-pt="off" x="' + (TRX - 4) + '" y="160" width="' + (TRW + 8) + '" height="148" fill="transparent"/>');
    s.push("</svg>");
    return s.join("");
  }

  /* ------------------------------------------------------------------ 3D dice */
  function pips(v) {
    var L = { 1: [[50, 50]], 2: [[27, 27], [73, 73]], 3: [[27, 27], [50, 50], [73, 73]], 4: [[27, 27], [73, 27], [27, 73], [73, 73]], 5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]], 6: [[27, 24], [73, 24], [27, 50], [73, 50], [27, 76], [73, 76]] }[v];
    return L.map(function (q) { return '<i style="left:' + q[0] + "%;top:" + q[1] + '%"></i>'; }).join("");
  }
  function cubeHtml() {
    var h = "";
    [1, 6, 3, 4, 2, 5].forEach(function (f) { h += '<div class="gcore c' + f + '"></div>'; });
    [1, 6, 3, 4, 2, 5].forEach(function (f) { h += '<div class="gf f' + f + '">' + pips(f) + "</div>"; });
    return h;
  }
  function orient(value, rz, extra) {
    var f = FACE[value]; extra = extra || [0, 0, 0];
    /* a die that lies flat shows its top face almost straight on (readable pips); only a cocked die keeps the strong tilt */
    var cocked = extra[1] !== 0 || extra[2] !== 0, tx = cocked ? -26 : 0, ty = cocked ? 24 : 0;
    return "rotateX(" + tx + "deg) rotateY(" + ty + "deg) rotateZ(" + (rz + extra[0]) + "deg) rotateY(" + (f[0] + extra[1]) + "deg) rotateX(" + (f[1] + extra[2]) + "deg)";
  }

  /* ------------------------------------------------------------------ small shared UI */
  /** a small notification in the corner of the screen (tap = open) */
  var noteEl = null, noteT = null;
  NG.cornerNote = function (o) {
    if (noteEl) { noteEl.remove(); noteEl = null; }
    clearTimeout(noteT);
    var n = el('<div class="cnote"><div class="cn-av"></div><div class="cn-t"><b></b><span></span></div></div>');
    n.querySelector("b").textContent = o.title || ""; n.querySelector("span").textContent = o.text || "";
    var av = n.querySelector(".cn-av");
    if (o.brief) { var rg = NG.ring(o.brief, { noStory: true }); rg.className = "ring none"; av.appendChild(rg); } else av.textContent = o.icon || "🎲";
    function hide() { if (!n.parentNode) return; n.classList.remove("in"); setTimeout(function () { n.remove(); if (noteEl === n) noteEl = null; }, 260); }
    n.onclick = function () { hide(); if (o.onTap) o.onTap(); };
    document.body.appendChild(n); noteEl = n;
    requestAnimationFrame(function () { requestAnimationFrame(function () { n.classList.add("in"); }); });
    NG.haptic("ok");
    noteT = setTimeout(hide, o.ms || 4600);
  };

  function xpChip() {
    var c = el('<span class="coinchip gxp"><span class="cn">🪙</span><b>…</b></span>');
    return c;
  }
  function setXp(chip, v) { if (!chip) return; var b = chip.querySelector("b"); if (b) b.textContent = v == null ? "∞" : num(v); chip.setAttribute("data-xp", v == null ? "∞" : String(v)); }

  /* ------------------------------------------------------------------ result texts */
  function outcome(v) {
    var win = v.winner === v.me, st = v.stake || 0, pot = st * 2, by = v.endedBy;
    if (by === "cancel") return { kind: "cancel", win: false, title: "میز بسته شد", line: st ? "ژتونت برگشت." : "", xp: "" };
    var line, xp = "";
    if (win) {
      if (by === "resign") line = "حریفت انصراف داد" + (st ? " و " + num(pot) + " ژتون به تو رسید." : ".");
      else if (by === "timeout") line = "وقت حریفت تموم شد" + (st ? " و " + num(pot) + " ژتون به تو رسید." : ".");
      else line = "همه‌ی مهره‌هات رو بیرون بردی" + (st ? " و " + num(pot) + " ژتون به تو رسید." : "!");
      if (st) xp = "+" + num(pot);
    } else {
      if (by === "resign") line = "انصراف دادی" + (st ? " و " + num(st) + " ژتون از دست رفت." : ".");
      else if (by === "timeout") line = "وقتت تموم شد" + (st ? " و " + num(st) + " ژتون از دست رفت." : ".");
      else line = "حریفت زودتر همه‌ی مهره‌هاش رو بیرون برد" + (st ? " و " + num(st) + " ژتون از دست رفت." : ".");
      if (st) xp = "−" + num(st);
    }
    return { kind: win ? "win" : "lose", win: win, title: win ? "تو بردی!" : "باختی", line: line, xp: xp, pot: win ? pot : st };
  }

  function showResult(host, v, onClose, onView) {
    var o = outcome(v);
    if (o.kind === "cancel") return null;
    var r = el('<div class="gres ' + o.kind + '"><div class="gres-bg"></div><div class="gres-fx"></div><div class="gres-card"><div class="gres-ico"></div><h2></h2><p></p><div class="gres-xp"></div><div class="gres-btns"><button class="btn blue tall" id="gnew">بازی‌ها</button><button class="btn tall" id="gsee">دیدن تخته</button></div></div></div>');
    r.querySelector("h2").textContent = o.title; r.querySelector("p").textContent = o.line;
    var ico = r.querySelector(".gres-ico");
    ico.innerHTML = o.win
      ? '<svg viewBox="0 0 120 120" class="gtro"><defs><linearGradient id="trg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#f2b705"/><stop offset="1" stop-color="#a96a00"/></linearGradient></defs><path d="M30 18h60v28c0 17-13 30-30 30S30 63 30 46Z" fill="url(#trg)" stroke="#7a4a00" stroke-width="2.4"/><path d="M30 26H14c0 20 8 30 22 33M90 26h16c0 20-8 30-22 33" fill="none" stroke="#e0a100" stroke-width="5" stroke-linecap="round"/><rect x="52" y="76" width="16" height="16" fill="url(#trg)" stroke="#7a4a00" stroke-width="2"/><rect x="36" y="92" width="48" height="12" rx="3" fill="url(#trg)" stroke="#7a4a00" stroke-width="2.4"/><path d="M42 24c0 18 3 32 10 40" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="4" stroke-linecap="round"/><path class="gshine" d="M60 14l4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="#fff"/></svg>'
      : '<div class="gsad">😔</div>';
    var xpEl = r.querySelector(".gres-xp");
    if (o.xp) { xpEl.innerHTML = '<span class="gxs">' + (o.win ? "🪙" : "💸") + '</span><b></b><small>ژتون</small>'; } else xpEl.style.display = "none";
    host.appendChild(r);
    // count-up
    if (o.xp) {
      var target = o.pot || 0, b = xpEl.querySelector("b"), t0 = Date.now(), sign = o.win ? "+" : "−";
      (function tick() { var k = Math.min(1, (Date.now() - t0) / 1100); b.textContent = sign + num(Math.round(target * (1 - Math.pow(1 - k, 3)))); if (k < 1 && r.parentNode) requestAnimationFrame(tick); })();
    }
    // particles
    var fx = r.querySelector(".gres-fx"), i;
    if (o.win) {
      for (i = 0; i < 26; i++) { (function (i) { var c = document.createElement("i"); c.className = "gcoin"; c.textContent = "🪙"; c.style.left = Math.random() * 100 + "%"; c.style.animationDelay = Math.random() * 2.2 + "s"; c.style.animationDuration = 2.2 + Math.random() * 1.8 + "s"; c.style.fontSize = 14 + Math.random() * 14 + "px"; fx.appendChild(c); })(i); }
      NG.confetti(); setTimeout(NG.confetti, 700); NG.haptic("ok");
    } else {
      for (i = 0; i < 22; i++) { (function (i) { var c = document.createElement("i"); c.className = "grain"; c.style.left = Math.random() * 100 + "%"; c.style.animationDelay = Math.random() * 2 + "s"; c.style.animationDuration = 1.2 + Math.random() * 1.2 + "s"; fx.appendChild(c); })(i); }
      NG.haptic("err");
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { r.classList.add("in"); }); });
    function hide(cb) { r.classList.remove("in"); setTimeout(function () { r.remove(); if (cb) cb(); }, 260); }
    r.querySelector("#gnew").onclick = function () { hide(onClose); };
    r.querySelector("#gsee").onclick = function () { hide(onView); };
    return r;
  }

  /* ------------------------------------------------------------------ the board screen */
  function openBoard(gid, first, onClosed) {
    var w = el('<div class="gmscr"></div>');
    var top = NG.topbar("تخته‌نرد", { right: svg("dots") }); w.appendChild(top);
    var body = el('<div class="gmbody">' +
      '<div class="gmtop"><div class="gmpot" id="pot"></div><button class="gmopp" id="opp"></button></div>' +
      '<div class="gmboard" id="brd"><div id="svgh"></div><div class="gmdice" id="dc"></div></div>' +
      '<div class="gmstat" id="st"></div>' +
      '<div class="gmclock" id="clk"><i></i><span></span></div>' +
      '<button class="btn blue tall gmroll" id="rl">🎲 تاس بنداز</button>' +
      '<div class="gmwait" id="wt"><div class="gmorbit"><i>⚀</i><i>⚃</i><i>⚅</i></div><p>منتظر یه حریف…<br><small id="wtn"></small></p><button class="btn blue" id="shg">📤 دعوت دوست با لینک</button><button class="btn" id="cn">لغو میز</button></div>' +
      "</div>");
    w.appendChild(body);
    var $ = function (id) { return body.querySelector("#" + id); };
    var scr = NG.push(w, { onClose: function () { alive = false; delete openBoards[gid]; clearTimeout(tm); clearInterval(tick); if (NG.gamesForget) NG.gamesForget(gid); if (onClosed) onClosed(); } });
    top.querySelector(".bk").onclick = scr.close;
    openBoards[gid] = true;
    var v = null, sel = null, alive = true, tm = null, tick = null, busy = false, endAt = 0, urgentBuzz = false, resShown = false, resEl = null, lastRollN = -1, ghostSeq = 0, entered = false;
    var brd = $("brd"), svgh = $("svgh"), dc = $("dc");

    function legal() { return v && v.legal ? v.legal : []; }
    function targets() {
      if (!v || sel == null) return [];
      var seen = {}, out = [];
      legal().forEach(function (m) {
        if (String(m.from) !== String(sel)) return;
        var k = String(m.to); if (seen[k]) return; seen[k] = 1;
        var hit = false; if (m.to !== "off") { var x = v.state.points[m.to - 1]; hit = x !== 0 && ((x > 0) !== (v.me === 0)) && Math.abs(x) === 1; }
        out.push({ to: m.to, hit: hit });
      });
      return out;
    }
    function movable() { var seen = {}, out = []; legal().forEach(function (m) { var k = String(m.from); if (!seen[k]) { seen[k] = 1; out.push(m.from); } }); return out; }
    function u() { return (brd.clientWidth || W) / W; }

    /* ---- status line */
    function statusText() {
      if (v.status === "waiting") return "منتظر حریف…";
      var l = v.last || {}, mine = v.me;
      if (v.status === "finished" || v.winner !== null) { var o = outcome(v); return o.kind === "cancel" ? o.title + (o.line ? " — " + o.line : "") : o.title + " — " + o.line; }
      var myTurn = v.state.turn === mine;
      if (myTurn && v.canRoll) {
        if (l.kind === "cocked" && l.by === mine) return "🎲 تاس از تخته افتاد! دوباره بنداز";
        if (l.kind === "pass" && l.by !== mine) return "حریفت حرکتی نداشت — نوبت توئه، تاس بنداز";
        return "نوبت توئه — تاس بنداز";
      }
      if (myTurn) return v.legal.length ? (sel == null ? "نوبت توئه — یه مهره رو انتخاب کن" : "حالا مقصد رو بزن") : "حرکتی نمونده…";
      if (l.kind === "cocked" && l.by !== mine) return "تاسِ حریف از تخته افتاد؛ دوباره می‌اندازه…";
      if (l.kind === "pass" && l.by === mine) return "حرکتی نداشتی — نوبت حریفه";
      return "نوبت حریفه…";
    }

    /* ---- the opponent field + pot chip */
    function paintHead() {
      var opp = v.me === 0 ? v.black : v.white, b = $("opp");
      var potN = (v.stake || 0) * (v.status === "waiting" ? 1 : 2);
      $("pot").innerHTML = v.stake > 0 ? '🪙 ژتون روی میز: <b>' + num(potN) + "</b>" : "🤝 دوستانه";
      if (opp) {
        b.innerHTML = "<span>" + esc(NG.nameOf(opp)) + "</span>" + NG.vb(opp);
        b.disabled = false; b.classList.remove("empty");
        b.onclick = function () { NG.haptic("sel"); NG.openProfile(opp.id); };
      } else { b.innerHTML = "<span>منتظر حریف…</span>"; b.disabled = true; b.classList.add("empty"); b.onclick = null; }
      var turnOpp = v.status === "active" && v.state && v.state.winner === null && v.state.turn !== v.me;
      b.classList.toggle("turn", !!turnOpp);
    }

    /* ---- the SVG board (rebuilt on every change) */
    function paintBoard(extra) {
      if (!v.state) { svgh.innerHTML = ""; return; }
      var myTurn = v.status === "active" && v.state.winner === null && v.state.turn === v.me && !!v.state.remaining;
      var o = { sel: myTurn ? sel : null, targets: myTurn ? targets() : [], movable: myTurn && sel == null ? movable() : [], lastTo: v.last && v.last.kind === "move" && typeof v.last.move.to === "number" ? v.last.move.to : null };
      if (extra) for (var k in extra) o[k] = extra[k];
      svgh.innerHTML = boardSvg(v, o);
      var sv = svgh.querySelector(".gmsvg");
      sv.onclick = onTap;
    }

    /* ---- dice */
    function diceMeta() {
      var r = v.roll; if (!r || !v.state) return null;
      var rd = rng(hash(gid) + (v.rollN || 0) * 7919), mine = r.by === v.me, cx = mine ? 265 : 91, list = [];
      for (var i = 0; i < 2; i++) {
        var cocked = r.cocked && r.off === i, x = cx + (i === 0 ? -21 : 21) + (rd() - 0.5) * 9, y = 162 + (rd() - 0.5) * 14, rz = (rd() - 0.5) * 44;
        if (cocked) { x = cx + (i === 0 ? -26 : 26) + (rd() - 0.5) * 16; y = mine ? H + 20 : -22; rz = (rd() - 0.5) * 120; }
        list.push({ v: r.dice[i], x: x, y: y, rz: rz, cocked: !!cocked });
      }
      return { list: list, mine: mine, by: r.by };
    }
    function usedFlags(meta) {
      var rem = v.state.remaining, r = v.roll, f = [false, false];
      if (!r) return f;
      if (v.last && (v.last.kind === "pass" || v.last.kind === "cocked")) return f;
      if (rem === null) return [true, true];
      if (r.dice[0] === r.dice[1]) { var used = 4 - rem.length; return [used >= 2, used >= 4]; }
      var left = rem.slice(); [0, 1].forEach(function (i) { var k = left.indexOf(r.dice[i]); if (k >= 0) left.splice(k, 1); else f[i] = true; });
      return f;
    }
    function syncDice(animate) {
      var meta = diceMeta();
      if (!meta) { dc.innerHTML = ""; return; }
      var us = u(), uf = usedFlags(meta), rem = v.state.remaining;
      dc.style.setProperty("--u", us + "px");
      var existing = dc.querySelectorAll(".dw");
      if (existing.length !== 2 || animate) {
        dc.innerHTML = "";
        meta.list.forEach(function (d, i) {
          var dw = el('<div class="dw ' + (meta.by === 0 ? "dv0" : "dv1") + '"><div class="dsh"></div><div class="cube">' + cubeHtml() + "</div></div>");
          dw.style.left = d.x * us + "px"; dw.style.top = d.y * us + "px";
          dc.appendChild(dw);
          var cube = dw.querySelector(".cube");
          cube.style.transform = orient(d.v, d.rz, d.cocked ? [0, 38, 31] : null);
          if (animate) throwDie(dw, cube, d, i, meta, us);
        });
        var badge = el('<div class="gdbadge"></div>'); dc.appendChild(badge);
      } else {
        existing.forEach(function (dw, i) { dw.style.left = meta.list[i].x * us + "px"; dw.style.top = meta.list[i].y * us + "px"; });
      }
      Array.prototype.forEach.call(dc.querySelectorAll(".dw"), function (dw, i) { dw.classList.toggle("used", !!uf[i]); });
      var bd = dc.querySelector(".gdbadge");
      if (bd) {
        var dbl = v.roll.dice[0] === v.roll.dice[1] && !v.roll.cocked && rem && rem.length > 0;
        bd.textContent = dbl ? "×" + num(rem.length) : ""; bd.style.display = dbl ? "flex" : "none";
        bd.style.left = (meta.mine ? 265 : 91) * us + "px"; bd.style.top = (162 + 24) * us + "px";
      }
    }
    function throwDie(dw, cube, d, i, meta, us) {
      if (!dw.animate) return;
      var r = rng(hash(gid + "t" + (v.rollN || 0) + i)), dir = meta.mine ? 1 : -1;
      var sx = (meta.mine ? 1 : -1) * (30 + r() * 50) * us * (i ? 1 : 0.4) + (r() - 0.5) * 40 * us, sy = dir * (205 + r() * 40) * us;
      var delay = i * 90, dur = 1050 + r() * 200;
      var kf = [
        { transform: "translate(" + sx + "px," + sy + "px) scale(1.55)", opacity: 0, offset: 0 },
        { transform: "translate(" + sx * 0.55 + "px," + sy * 0.55 + "px) scale(1.5)", opacity: 1, offset: 0.1 },
        { transform: "translate(" + sx * 0.12 + "px," + sy * 0.1 + "px) scale(1.05)", opacity: 1, offset: 0.46 },
        { transform: "translate(" + (-sx * 0.1) + "px," + (-dir * 14 * us) + "px) scale(1.3)", opacity: 1, offset: 0.58 },
        { transform: "translate(" + (sx * 0.03) + "px," + (dir * 4 * us) + "px) scale(1)", opacity: 1, offset: 0.74 },
        { transform: "translate(0,-" + dir * 5 * us + "px) scale(1.1)", opacity: 1, offset: 0.86 },
        { transform: "translate(0,0) scale(1)", opacity: 1, offset: 1 }
      ];
      dw.animate(kf, { duration: dur, delay: delay, easing: "cubic-bezier(.3,.6,.4,1)", fill: "backwards" });
      var f = FACE[d.v], ex = d.cocked ? [0, 38, 31] : [0, 0, 0];
      var a = (r() > 0.5 ? 1 : -1) * (360 * (2 + Math.floor(r() * 2))), b = (r() > 0.5 ? 1 : -1) * (360 * (1 + Math.floor(r() * 2))), c = (r() > 0.5 ? 1 : -1) * 360;
      cube.animate([
        { transform: "rotateX(-26deg) rotateY(24deg) rotateZ(" + (d.rz + ex[0] + c) + "deg) rotateY(" + (f[0] + ex[1] + a) + "deg) rotateX(" + (f[1] + ex[2] + b) + "deg)" },
        { transform: orient(d.v, d.rz, d.cocked ? [0, 38, 31] : null) }
      ], { duration: dur, delay: delay, easing: "cubic-bezier(.16,.62,.28,1)", fill: "backwards" });
      var sh = dw.querySelector(".dsh");
      if (sh) sh.animate([{ transform: "scale(.5)", opacity: 0.25, offset: 0 }, { transform: "scale(1.15)", opacity: 0.8, offset: 0.46 }, { transform: "scale(.7)", opacity: 0.4, offset: 0.58 }, { transform: "scale(1)", opacity: 0.8, offset: 1 }], { duration: dur, delay: delay, fill: "backwards" });
      setTimeout(function () { NG.haptic("sel"); }, delay + dur * 0.46);
      setTimeout(function () { NG.haptic("sel"); }, delay + dur * 0.74);
    }

    /* ---- a checker gliding from one place to another */
    function ghostMove(prev, next) {
      var m = next.last && next.last.move; if (!m || !prev || !prev.state) return null;
      var me = next.me, who = next.last.by, st0 = prev.state, st1 = next.state, from, to;
      if (m.from === "bar") from = barPos(who, Math.max(0, st0.bar[who] - 1), me);
      else { var c0 = Math.abs(st0.points[m.from - 1]); from = ckPos(m.from, c0 - 1, c0, me); }
      if (m.to === "off") to = trayPos(who, Math.max(0, st1.off[who] - 1), me);
      else { var c1 = Math.abs(st1.points[m.to - 1]); to = ckPos(m.to, c1 - 1, c1, me); }
      return { from: from, to: to, who: who, off: m.to === "off", pt: m.to === "off" ? null : m.to, hit: m.to !== "off" && st1.bar[1 - who] > st0.bar[1 - who] };
    }
    function runGhost(g) {
      var sv = svgh.querySelector(".gmsvg"); if (!sv || !g) return;
      var id = ++ghostSeq, el2 = document.createElementNS("http://www.w3.org/2000/svg", "use");
      el2.setAttribute("href", "#ck" + (g.who === 0 ? "w" : "b")); el2.setAttribute("x", 0); el2.setAttribute("y", 0);
      el2.setAttribute("class", "gmghost");
      sv.appendChild(el2);
      var dx = g.to.x - g.from.x, dy = g.to.y - g.from.y;
      var an = el2.animate ? el2.animate([
        { transform: "translate(" + g.from.x + "px," + g.from.y + "px) scale(1)" },
        { transform: "translate(" + (g.from.x + dx * 0.5) + "px," + (g.from.y + dy * 0.5 - 16) + "px) scale(1.28)", offset: 0.5 },
        { transform: "translate(" + g.to.x + "px," + g.to.y + "px) scale(1)" }
      ], { duration: 360, easing: "cubic-bezier(.3,.1,.3,1)", fill: "forwards" }) : null;
      function land() {
        if (id !== ghostSeq || !alive) return;
        paintBoard({ popBar: g.hit ? 1 - g.who : null, dropOff: g.off ? g.who : null });
        if (g.hit) NG.haptic("err");
      }
      if (an) an.onfinish = land; else land();
    }

    /* ---- the clock */
    function paintClock() {
      var c = $("clk");
      if (!v || v.status !== "active" || v.winner !== null || !endAt) { c.style.display = "none"; return; }
      c.style.display = "flex";
      var left = Math.max(0, (endAt - Date.now()) / 1000), mine = v.state.turn === v.me;
      c.querySelector("i").style.transform = "scaleX(" + Math.min(1, left / v.idleMax) + ")";
      c.querySelector("span").textContent = (mine ? "وقت تو: " : "وقت حریف: ") + mmss(left);
      c.classList.toggle("mine", mine); c.classList.toggle("urgent", left <= 15);
      if (mine && left <= 15 && !urgentBuzz) { urgentBuzz = true; NG.haptic("err"); }
      if (left > 16) urgentBuzz = false;
      if (left <= 0 && !busy) poll();
    }

    /* ---- one full repaint */
    function paint(opts) {
      opts = opts || {};
      if (!v) return;
      paintHead();
      var waiting = v.status === "waiting";
      $("wt").style.display = waiting ? "flex" : "none";
      brd.style.display = waiting ? "none" : "block";
      $("wtn").innerHTML = "میز تا ۱۵ دقیقه باز می‌مونه" + (v.stake > 0 ? "<br>ژتون روی میز نگه داشته می‌شه و اگه کسی نیومد برمی‌گرده." : "");
      if (!waiting) {
        paintBoard(opts.board);
        if (!entered) { entered = true; brd.classList.add("in"); }
        syncDice(!!opts.animateRoll);
      }
      var stEl = $("st"); stEl.textContent = statusText();
      var myTurn = v.status === "active" && v.state && v.state.winner === null && v.state.turn === v.me;
      stEl.classList.toggle("go", !!myTurn);
      var rl = $("rl"); rl.style.display = v.canRoll ? "flex" : "none";
      paintClock();
    }

    /* ---- taps */
    function doMove(m) { sel = null; act("game_move", { from: m.from, to: m.to, die: m.die }); }
    function onTap(e) {
      var t = e.target.closest ? e.target.closest("[data-pt]") : null;
      if (!t || busy || !v || v.status !== "active" || !v.state || v.state.turn !== v.me || !v.state.remaining) return;
      var raw = t.getAttribute("data-pt"), pt = raw === "bar" || raw === "off" ? raw : Number(raw);
      var tg = targets(), isT = tg.some(function (x) { return String(x.to) === String(pt); });
      if (sel != null && isT) {
        var mv = legal().filter(function (m) { return String(m.from) === String(sel) && String(m.to) === String(pt); });
        // bearing off with a larger die than needed: use the smallest die that works; otherwise the larger first
        mv.sort(function (a, b) { return pt === "off" ? a.die - b.die : b.die - a.die; });
        return doMove(mv[0]);
      }
      var canFrom = legal().some(function (m) { return String(m.from) === String(pt); });
      if (canFrom) { if (String(sel) === String(pt)) sel = null; else { sel = pt; NG.haptic("sel"); } paintBoard(); $("st").textContent = statusText(); return; }
      // quick move: tapping a landing spot that exactly one legal move reaches
      if (sel == null) {
        var hits = legal().filter(function (m) { return String(m.to) === String(pt); });
        if (hits.length === 1) return doMove(hits[0]);
      }
      sel = null; paintBoard(); $("st").textContent = statusText();
    }

    /* ---- applying a new state from the server */
    function apply(nv) {
      if (!nv || nv.unchanged) return;
      var prev = v;
      if (prev && nv.v === prev.v && nv.status === prev.status) { // nothing new: only the clock moves
        v.idleLeft = nv.idleLeft; v.myXp = nv.myXp; endAt = nv.idleLeft != null ? Date.now() + nv.idleLeft * 1000 : 0; paintClock(); return;
      }
      v = nv; sel = null;
      endAt = v.idleLeft != null && v.status === "active" ? Date.now() + v.idleLeft * 1000 : 0;
      urgentBuzz = false;
      var newRoll = lastRollN >= 0 && v.rollN > lastRollN && v.roll;
      lastRollN = v.rollN;
      var ghost = prev && prev.state && v.state && v.last && v.last.kind === "move" && v.v === prev.v + 1 || (prev && prev.state && v.last && v.last.kind === "move" && prev.v !== v.v) ? ghostMove(prev, v) : null;
      if (ghost) paint({ board: { skip: ghost.off ? { off: ghost.who } : { pt: ghost.pt } } });
      else paint({ animateRoll: !!newRoll });
      if (ghost) runGhost(ghost);
      if (newRoll && v.roll.cocked) NG.toast(v.roll.by === v.me ? "🎲 یکی از تاس‌ها از تخته افتاد! دوباره بنداز." : "🎲 تاسِ حریف از تخته افتاد؛ دوباره می‌اندازه.");
      if (prev && prev.status === "waiting" && v.status === "active") {
        var o2 = v.me === 0 ? v.black : v.white;
        if (o2) NG.cornerNote({ brief: o2, title: NG.nameOf(o2) + " وارد بازی شد", text: v.state && v.state.turn === v.me ? "نوبت توئه — تاس بنداز" : "اول حریفت تاس می‌اندازه", ms: 4200 });
      }
      if (prev && prev.status !== "finished" && v.status === "finished" && v.endedBy === "cancel") { NG.toast("میز بسته شد" + (v.stake ? " — ژتونت برگشت" : "")); alive = false; scr.close(); return; }
      if ((v.status === "finished" || v.winner !== null) && !resShown) { resShown = true; clearTimeout(resTimer); resTimer = setTimeout(function () { if (!alive) return; resEl = showResult(w, v, function () { alive = false; scr.close(); }, function () {}); if (NG.me && v.myXp !== undefined && NG.refreshMe) NG.refreshMe(); }, ghost ? 700 : 350); }
    }
    var resTimer = null;
    function act(action, extra, closeAfter) {
      if (busy) return; busy = true;
      var b = { gid: gid }; for (var k in extra) b[k] = extra[k];
      NG.api(action, b).then(function (r) {
        busy = false;
        if (!r.ok) { NG.haptic("err"); NG.toast(NG.errText(r)); sel = null; poll(); return; }
        apply(r.data); if (closeAfter) { alive = false; scr.close(); }
      }).catch(function () { busy = false; NG.netErr(); });
    }
    function poll() {
      if (!alive) return;
      NG.api("game_state", { gid: gid, since: v ? v.v : undefined }).then(function (r) {
        if (!alive) return;
        if (!r.ok) { if (r.status === 404) { NG.toast("این بازی دیگه وجود نداره."); alive = false; scr.close(); } return; }
        if (!busy) apply(r.data);
      }).catch(function () {});
    }
    function loop() { if (!alive) return; if (!document.body.contains(w)) { alive = false; return; } if (!document.hidden && !busy) poll(); tm = setTimeout(loop, 1500); }

    $("rl").onclick = function () { $("rl").disabled = true; act("game_roll", {}); setTimeout(function () { $("rl").disabled = false; }, 600); };
    $("shg").onclick = function () { NG.share("game", gid); };
    $("cn").onclick = function () { NG.confirm("لغو میز؟", "میز بسته می‌شه" + (v && v.stake ? " و ژتونت برمی‌گرده." : "."), "تأیید", function () { act("game_resign", {}, true); }); };
    top.querySelector(".rt").onclick = function () {
      if (!v || v.status === "finished") return;
      NG.actions([{ label: v.status === "waiting" ? "لغو میز" : "انصراف از بازی", cls: "red", fn: function () { NG.confirm(v.status === "waiting" ? "لغو میز؟" : "انصراف؟", v.status === "waiting" ? "میز بسته می‌شه." : "بازی رو می‌بازی" + (v.stake ? " و " + num(v.stake) + " ژتون از دست می‌ره." : "."), "تأیید", function () { act("game_resign", {}); }); } }]);
    };
    window.addEventListener("resize", function onR() { if (!alive) return window.removeEventListener("resize", onR); if (v && v.state) syncDice(false); });
    tick = setInterval(function () { if (alive) paintClock(); }, 250);

    if (first) { v = first; lastRollN = first.rollN || 0; endAt = v.idleLeft != null && v.status === "active" ? Date.now() + v.idleLeft * 1000 : 0; paint({}); if ((v.status === "finished" || v.winner !== null) && !resShown) { resShown = true; resEl = showResult(w, v, function () { alive = false; scr.close(); }, function () {}); } }
    else { paintHeadSkeleton(); }
    function paintHeadSkeleton() { $("wt").style.display = "none"; brd.style.display = "none"; $("rl").style.display = "none"; $("clk").style.display = "none"; $("st").textContent = "…"; }
    // the first request also gives the very first state when we did not get one
    if (!first) NG.api("game_state", { gid: gid }).then(function (r) { if (!alive) return; if (!r.ok) { NG.toast(NG.errText(r)); alive = false; scr.close(); return; } v = r.data; lastRollN = v.rollN || 0; endAt = v.idleLeft != null && v.status === "active" ? Date.now() + v.idleLeft * 1000 : 0; paint({}); if ((v.status === "finished" || v.winner !== null) && !resShown) { resShown = true; resEl = showResult(w, v, function () { alive = false; scr.close(); }, function () {}); } }).catch(NG.netErr);
    loop();
    return scr;
  }

  /* ------------------------------------------------------------------ backgammon lobby */
  var stakeSel = 0;
  NG.openGame = function (opts) {
    opts = opts || {};
    var w = el('<div class="gmlob"></div>');
    var chip = xpChip();
    var top = NG.topbar("تخته‌نرد 🎲", { right: "" }); w.appendChild(top);
    var rt = top.querySelector(".rt"); rt.style.visibility = "visible"; rt.innerHTML = ""; rt.appendChild(chip); rt.onclick = function () { var x = chip.getAttribute("data-xp"); NG.toast("موجودی ژتون تو: " + (x === "∞" ? "نامحدود ∞" : num(Number(x) || 0))); };
    setXp(chip, NG.me && NG.me.relic != null ? (NG.me.unlimited ? null : NG.me.relic) : 0);
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);
    var alive = true, sig = "", autoDone = !!opts.noAuto, inBoard = false;
    var scr = NG.push(w, { onClose: function () { alive = false; } });
    top.querySelector(".bk").onclick = scr.close;

    function enter(gid, view) {
      inBoard = true;
      openBoard(gid, view || null, function () { inBoard = false; sig = ""; load(true); });
    }
    function rowFor(g) {
      var o = g.opp, label, cls = "";
      if (g.status === "waiting") label = "منتظر حریف…";
      else if (g.myTurn) { label = "نوبت توئه"; cls = " go"; } else label = "نوبت حریفه";
      var r = el('<div class="row gmrow' + cls + '"><div class="t"><b>' + (o ? esc(NG.nameOf(o)) + NG.vb(o) : "میز باز") + "</b><span>" + label + (g.stake ? " · 🪙 " + num(g.stake) + " ژتون" : " · دوستانه") + '</span></div><button class="fbtn' + (g.myTurn ? "" : " gray") + '">' + (g.myTurn ? "بازی کن" : "ادامه") + "</button></div>");
      var rg = o ? NG.ring(o, { noStory: true }) : el('<div class="ring none"><div class="in gmdie">🎲</div></div>'); rg.className = "ring none"; r.insertBefore(rg, r.firstChild);
      if (g.myTurn) r.querySelector(".t").appendChild(el('<i class="gmdot"></i>'));
      r.onclick = function () { enter(g.gid, null); };
      return r;
    }
    function render(d) {
      body.className = ""; body.innerHTML = "";
      setXp(chip, d.myXp);
      if (d.mine.length) {
        body.appendChild(el('<div class="hint"><span>بازی‌های من</span><small class="gmsmall">' + num(d.mine.length) + " از " + num(d.max) + "</small></div>"));
        d.mine.forEach(function (g) { body.appendChild(rowFor(g)); });
      } else body.appendChild(el('<div class="gmhero"><div class="gmbig">🎲</div><h3>تخته‌نرد دو نفره</h3><p>با یه کاربر دیگه‌ی مویاگرام بازی کن. هر حرکت ۲ دقیقه وقت داره.</p></div>'));
      body.appendChild(el('<div class="hint"><span>بازی جدید</span></div>'));
      if (d.canCreate) {
        var stakes = d.stakes || [0, 1, 2, 5, 10, 20, 50, 100];
        var chips = el('<div class="gmstakes"><div class="gmsl">ژتون روی میز (هر نفر؛ برنده همه‌ی جایزه رو می‌بره)</div><div class="gmsr"></div></div>');
        stakeSel = stakes.indexOf(stakeSel) >= 0 ? stakeSel : 0;
        var n = el('<button class="btn blue tall gmmk"></button>');
        var lab = function () { n.textContent = stakeSel ? "ساخت میز با " + num(stakeSel) + " ژتون" : "ساخت میز دوستانه (بدون ژتون)"; };
        stakes.forEach(function (s) {
          var c = el('<button class="gmchip' + (s === stakeSel ? " on" : "") + '">' + (s ? "🪙 " + num(s) : "دوستانه") + "</button>");
          c.onclick = function () { stakeSel = s; Array.prototype.forEach.call(chips.querySelectorAll(".gmchip"), function (x) { x.classList.remove("on"); }); c.classList.add("on"); NG.haptic("sel"); lab(); };
          chips.querySelector(".gmsr").appendChild(c);
        });
        lab(); body.appendChild(chips);
        n.onclick = function () {
          n.disabled = true;
          NG.api("game_create", { stake: stakeSel || 0 }).then(function (rr) {
            if (!rr.ok) { n.disabled = false; if (guestStop(rr)) return; return NG.toast(rr.data && rr.data.error === "insufficient" ? "ژتون کافی برای این مبلغ نداری." : NG.errText(rr)); }
            enter(rr.data.gid, rr.data);
          }).catch(function () { n.disabled = false; NG.netErr(); });
        };
        body.appendChild(n);
      } else if (d.mine.some(function (g) { return g.status === "waiting"; })) body.appendChild(el('<div class="gmnote">یه میز بازِ منتظر داری؛ تا حریف نیومده میز دوم نمی‌شه ساخت.</div>'));
      else body.appendChild(el('<div class="gmnote">به سقف ' + num(d.max) + " بازی هم‌زمان رسیدی؛ یکی رو تموم کن.</div>"));
      body.appendChild(el('<div class="hint"><span>میزهای باز</span></div>'));
      if (!d.open.length) body.appendChild(el('<div class="empty" style="padding:22px">الان میز بازی نیست؛ خودت یکی بساز.</div>'));
      d.open.forEach(function (t) {
        var r2 = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(t.host)) + NG.vb(t.host) + "</b><span>" + NG.ago(t.at) + (t.stake ? " · 🪙 " + num(t.stake) + " ژتون" : " · دوستانه") + '</span></div><button class="fbtn">بپیوند' + (t.stake ? " (" + num(t.stake) + " ژتون)" : "") + "</button></div>");
        var rg = NG.ring(t.host, { noStory: true }); rg.className = "ring none"; r2.insertBefore(rg, r2.firstChild);
        r2.querySelector("button").onclick = function (e) {
          e.stopPropagation();
          NG.api("game_join", { gid: t.gid }).then(function (rr) {
            if (!rr.ok) { if (guestStop(rr)) { sig = ""; return; } var er = rr.data && rr.data.error; NG.toast(er === "not_found" ? "این میز دیگه نیست." : er === "insufficient" ? "ژتون کافی برای هم‌اندازه کردن مبلغ میز نداری." : er === "same_opponent" ? "با این بازیکن همین الان یه بازی در جریان داری." : NG.errText(rr)); sig = ""; return load(true); }
            enter(rr.data.gid, rr.data);
          }).catch(NG.netErr);
        };
        body.appendChild(r2);
      });
    }
    function load(force) {
      NG.api("game_lobby").then(function (r) {
        if (!alive) return;
        if (!r.ok) { if (!sig) { body.className = ""; body.innerHTML = ""; } return NG.toast(NG.errText(r)); }
        var d = r.data;
        var s2 = JSON.stringify([d.mine.map(function (g) { return [g.gid, g.status, g.myTurn, g.opp && g.opp.id]; }), d.open.map(function (t) { return t.gid; }), d.canCreate, d.myXp]);
        setXp(chip, d.myXp);
        if (force || s2 !== sig) { sig = s2; if (!inBoard) render(d); }
        // coming back to the page while a game is running: show that table straight away
        if (!autoDone && d.mine.length) {
          autoDone = true;
          var pick = d.mine.filter(function (g) { return g.myTurn; })[0] || d.mine[0];
          enter(pick.gid, null);
        } else autoDone = true;
      }).catch(NG.netErr);
    }
    load(true);
    (function loop() { setTimeout(function () { if (!alive || !document.body.contains(w)) return; if (!document.hidden && !inBoard) load(false); loop(); }, 4000); })();
  };

  /* ------------------------------------------------------------------ the games hub */
  var LOGO = {
    nard: '<svg viewBox="0 0 64 64"><g transform="rotate(-14 24 40)"><rect x="6" y="22" width="30" height="30" rx="7" fill="#fff8e6" stroke="#cdbb92" stroke-width="2"/><g fill="#1b1b1f"><circle cx="14" cy="30" r="3"/><circle cx="21" cy="37" r="3"/><circle cx="28" cy="44" r="3"/></g></g><g transform="rotate(16 44 26)"><rect x="30" y="8" width="28" height="28" rx="7" fill="#e5483f" stroke="#8d1610" stroke-width="2"/><g fill="#fff6e0"><circle cx="38" cy="16" r="3"/><circle cx="50" cy="16" r="3"/><circle cx="38" cy="28" r="3"/><circle cx="50" cy="28" r="3"/><circle cx="44" cy="22" r="3"/></g></g></svg>',
    chess: '<svg viewBox="0 0 64 64"><path d="M16 54h32v-6H16Zm4-8h24l-3-22H23Zm-4-26h6v-6h6v6h8v-6h6v6h6v-10H16Z" fill="#f4f1ea" stroke="#2b2b30" stroke-width="2.2" stroke-linejoin="round"/></svg>',
    ludo: '<svg viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" rx="8" fill="#fff"/><path d="M8 16a8 8 0 0 1 8-8h16v24H8Z" fill="#e5483f"/><path d="M32 8h16a8 8 0 0 1 8 8v16H32Z" fill="#2f9e5b"/><path d="M8 32h24v24H16a8 8 0 0 1-8-8Z" fill="#f2b705"/><path d="M32 32h24v16a8 8 0 0 1-8 8H32Z" fill="#2a6fdb"/><circle cx="32" cy="27" r="6" fill="#fff" stroke="#222" stroke-width="2"/><path d="M26 42c0-6 3-9 6-9s6 3 6 9Z" fill="#fff" stroke="#222" stroke-width="2"/></svg>',
    domino: '<svg viewBox="0 0 64 64"><g transform="rotate(-18 32 32)"><rect x="18" y="6" width="28" height="52" rx="7" fill="#fff8e6" stroke="#2b2b30" stroke-width="2.2"/><path d="M20 32h24" stroke="#2b2b30" stroke-width="2.2"/><g fill="#2b2b30"><circle cx="26" cy="15" r="3"/><circle cx="38" cy="25" r="3"/><circle cx="26" cy="41" r="3"/><circle cx="38" cy="41" r="3"/><circle cx="26" cy="51" r="3"/><circle cx="38" cy="51" r="3"/></g></g></svg>',
    cards: '<svg viewBox="0 0 64 64"><g transform="rotate(-12 28 36)"><rect x="10" y="12" width="32" height="44" rx="6" fill="#fff" stroke="#2b2b30" stroke-width="2.2"/><path d="M26 44s-9-5.4-9-11.6a5 5 0 0 1 9-3 5 5 0 0 1 9 3C35 38.6 26 44 26 44Z" fill="#e5483f"/></g><g transform="rotate(14 42 34)"><rect x="28" y="8" width="30" height="42" rx="6" fill="#fff" stroke="#2b2b30" stroke-width="2.2"/><path d="M43 18c-7 7-11 10-11 15a6 6 0 0 0 9 4.4c0 3-1 5-3 7h10c-2-2-3-4-3-7a6 6 0 0 0 9-4.4c0-5-4-8-11-15Z" transform="translate(-1 0) scale(.82) translate(8 2)" fill="#222"/></g></svg>',
    xo: '<svg viewBox="0 0 64 64"><path d="M24 8v48M40 8v48M8 24h48M8 40h48" stroke="#cfd3da" stroke-width="3" stroke-linecap="round"/><path d="M11 11l10 10M21 11 11 21" stroke="#e5483f" stroke-width="4" stroke-linecap="round"/><circle cx="48" cy="48" r="6" fill="none" stroke="#2a6fdb" stroke-width="4"/><circle cx="32" cy="32" r="6" fill="none" stroke="#2a6fdb" stroke-width="4"/><path d="M43 11l10 10M53 11 43 21" stroke="#e5483f" stroke-width="4" stroke-linecap="round"/></svg>'
  };
  var TILES = [
    { id: "nard", name: "تخته‌نرد", bg: "linear-gradient(150deg,#8d5226,#46240f)", logo: LOGO.nard, live: true },
    { id: "chess", name: "شطرنج", bg: "linear-gradient(150deg,#3b4252,#1b1f2a)", logo: LOGO.chess },
    { id: "ludo", name: "منچ", bg: "linear-gradient(150deg,#2f9e5b,#145a34)", logo: LOGO.ludo },
    { id: "domino", name: "دومینو", bg: "linear-gradient(150deg,#7a3fd0,#3a1b7a)", logo: LOGO.domino },
    { id: "cards", name: "حکم", bg: "linear-gradient(150deg,#d6485a,#7a1830)", logo: LOGO.cards },
    { id: "xo", name: "دوز", bg: "linear-gradient(150deg,#2a6fdb,#143a7a)", logo: LOGO.xo }
  ];
  var lastItems = [];
  NG.openGames = function () {
    var w = el('<div class="gmhub"></div>');
    var top = NG.topbar("بازی‌ها 🎮"); w.appendChild(top);
    var grid = el('<div class="gmgrid"></div>'); w.appendChild(grid);
    w.appendChild(el('<div class="gmsoon">بازی‌های بیشتر به‌زودی اضافه می‌شن ✨</div>'));
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    TILES.forEach(function (t, i) {
      var b = el('<button class="gtile' + (t.live ? "" : " soon") + '" style="background:' + t.bg + ';animation-delay:' + i * 60 + 'ms"><div class="gtl">' + t.logo + '</div><b>' + t.name + '</b>' + (t.live ? '<small class="gtn"></small><i class="gdot hide"></i>' : '<span class="gsn">به‌زودی</span>') + "</button>");
      b.onclick = function () {
        if (t.live) { NG.haptic("sel"); NG.openGame(); return; }
        NG.haptic("err"); b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); NG.toast("🚧 " + t.name + " به‌زودی میاد!");
      };
      grid.appendChild(b);
    });
    function mark() {
      var live = grid.querySelector(".gtile:not(.soon)"); if (!live) return;
      var turn = lastItems.filter(function (x) { return x.t; }).length;
      live.querySelector(".gdot").classList.toggle("hide", !turn);
      var n = live.querySelector(".gtn"); n.textContent = lastItems.length ? num(lastItems.length) + " بازی" : "";
    }
    mark();
    var iv = setInterval(function () { if (!document.body.contains(w)) return clearInterval(iv); mark(); }, 1500);
  };

  /* ------------------------------------------------------------------ the floating button + the live pulse */
  var fab = null, prevGames = null;
  /** v1.27: a guest (registration unfinished) may sit at a shared table; creating/sharing tables and staked tables need an account → «ثبت‌نام» */
  function guestStop(r) {
    var e = r && r.data && r.data.error;
    if (!NG.guest || (e !== "not_registered" && e !== "insufficient")) return false;
    NG.haptic("err"); NG.guestGate(e === "insufficient" ? "این میز ژتون داره؛ برای شرکت توش اول در ربات ثبت نام کنید." : null);
    return true;
  }
  NG.mountGameFab = function () {
    if (fab) return;
    fab = el('<button class="gfab" aria-label="games"><svg viewBox="0 0 48 48"><rect x="6" y="6" width="36" height="36" rx="10" fill="url(#gfg)"/><defs><linearGradient id="gfg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a3d"/><stop offset=".55" stop-color="#e1306c"/><stop offset="1" stop-color="#7a3fd0"/></linearGradient></defs><g fill="#fff"><circle cx="16" cy="16" r="3.2"/><circle cx="32" cy="16" r="3.2"/><circle cx="24" cy="24" r="3.2"/><circle cx="16" cy="32" r="3.2"/><circle cx="32" cy="32" r="3.2"/></g></svg><i class="gdot hide"></i></button>');
    fab.onclick = function () { NG.haptic("sel"); NG.openGames(); };
    NG.col.appendChild(fab);
  };
  NG.setFabAway = function (away) { if (fab) fab.classList.toggle("away", !!away); };
  /** opened from a shared game link (?go=g_<gid>): sit down at that table (or re-open it if it is already mine) */
  NG.joinGameByLink = function (gid) {
    NG.api("game_state", { gid: gid }).then(function (r) {
      if (r.ok && r.data && r.data.status) return openBoard(gid, r.data);
      NG.api("game_join", { gid: gid }).then(function (rr) {
        if (!rr.ok) { if (guestStop(rr)) return; var er = rr.data && rr.data.error; return NG.toast(er === "insufficient" ? "ژتون کافی برای این میز نداری." : er === "not_found" ? "این میز دیگه نیست." : NG.errText(rr)); }
        openBoard(rr.data.gid, rr.data);
      }).catch(NG.netErr);
    }).catch(NG.netErr);
  };
  NG.gamesForget = function (gid) { if (prevGames) delete prevGames[gid]; };
  function announceFinished(gid) {
    NG.api("game_state", { gid: gid }).then(function (r) {
      if (!r.ok || !r.data || r.data.status !== "finished") return;
      var v = r.data, o = outcome(v), opp = v.me === 0 ? v.black : v.white;
      NG.cornerNote({ brief: opp || null, icon: o.win ? "🏆" : "😔", title: o.kind === "cancel" ? "میز بسته شد" : o.win ? "تو بردی!" : "باختی", text: o.line, ms: 6500, onTap: function () { if (!openBoards[gid]) openBoard(gid, v); } });
    }).catch(function () {});
  }
  NG.gamesPulse = function (g) {
    var items = (g && g.items) || [], map = {};
    items.forEach(function (it) { map[it.gid] = it; });
    lastItems = items;
    var turn = items.filter(function (x) { return x.t; }).length;
    if (fab) { fab.querySelector(".gdot").classList.toggle("hide", !turn); fab.classList.toggle("turn", turn > 0); }
    if (prevGames) {
      items.forEach(function (it) {
        var p = prevGames[it.gid];
        if (p && p.st === "w" && it.st === "a" && !openBoards[it.gid]) {
          NG.cornerNote({ icon: "🎲", title: (it.o || "یه نفر") + " وارد بازی شد", text: "بازی تخته‌نرد شروع شد — بزن تا بری تو میز", onTap: function () { openBoard(it.gid, null); } });
        }
      });
      Object.keys(prevGames).forEach(function (gid) { if (!map[gid] && !openBoards[gid]) announceFinished(gid); });
    }
    prevGames = map;
  };
})();
