/* نوا گرام — تخته‌نرد دو نفره (آزمایشی). The server (api/miniapp.ts game_* actions) owns the rules; this file only draws the board and sends taps.
   Board: SVG, tap a checker then a highlighted point. The board is rotated for the black player so everybody's home is bottom-right. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;
  var PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  var W = 344, H = 300, PW = 24, BARX = 162, MARG = 8;

  function colX(col) { return col < 6 ? MARG + col * PW + PW / 2 : 172 + (col - 6) * PW + PW / 2; }
  /** where point pt sits for the viewer `me` → {x, top} */
  function place(pt, me) {
    var top, col;
    if (pt >= 13) { top = true; col = pt - 13; } else { top = false; col = 12 - pt; }
    var x = colX(col);
    if (me === 1) { x = 324 - x; top = !top; } // rotate 180°: black's home ends up bottom-right too
    return { x: x, top: top };
  }

  function boardSvg(v, sel, targets, lastMove) {
    var me = v.me, st = v.state, s = [];
    s.push('<svg class="bgsvg" viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg">');
    s.push('<defs><linearGradient id="gwood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b3f1d"/><stop offset="1" stop-color="#4a2a12"/></linearGradient>' +
      '<linearGradient id="gfelt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f6b4a"/><stop offset="1" stop-color="#175238"/></linearGradient>' +
      '<radialGradient id="gw" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfc8b4"/></radialGradient>' +
      '<radialGradient id="gb" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#5a5a62"/><stop offset="1" stop-color="#16161a"/></radialGradient></defs>');
    s.push('<rect width="' + W + '" height="' + H + '" rx="14" fill="url(#gwood)"/>');
    s.push('<rect x="' + MARG + '" y="' + MARG + '" width="144" height="284" rx="6" fill="url(#gfelt)"/><rect x="172" y="' + MARG + '" width="144" height="284" rx="6" fill="url(#gfelt)"/>');
    s.push('<rect x="152" y="0" width="20" height="' + H + '" fill="#3a200d"/>');
    // triangles + hit areas
    for (var pt = 1; pt <= 24; pt++) {
      var p = place(pt, me), x0 = p.x - PW / 2, dark = pt % 2 === 0;
      var tip = p.top ? 8 + 118 : 292 - 118, base = p.top ? 8 : 292;
      var isT = targets && targets.indexOf(pt) >= 0;
      s.push('<polygon points="' + x0 + "," + base + " " + (x0 + PW) + "," + base + " " + p.x + "," + tip + '" fill="' + (dark ? "#d8b46a" : "#8f2f2a") + '" opacity="' + (isT ? 1 : 0.92) + '"/>');
      if (isT) s.push('<circle cx="' + p.x + '" cy="' + (p.top ? 8 + 24 : 292 - 24) + '" r="8" fill="#2ecc71" opacity=".9" class="bgtg"/>');
      s.push('<rect data-pt="' + pt + '" x="' + x0 + '" y="' + (p.top ? 8 : 172) + '" width="' + PW + '" height="120" fill="transparent"/>');
    }
    // checkers on points
    function checker(cx, cy, who, hl) {
      return '<circle cx="' + cx + '" cy="' + cy + '" r="10.5" fill="url(#' + (who === 0 ? "gw" : "gb") + ')" stroke="' + (hl ? "#ffd54a" : who === 0 ? "#9a937c" : "#000") + '" stroke-width="' + (hl ? 2.4 : 1) + '"/><circle cx="' + cx + '" cy="' + cy + '" r="6" fill="none" stroke="' + (who === 0 ? "#b9b29c" : "#3a3a42") + '" stroke-width=".8"/>';
    }
    for (pt = 1; pt <= 24; pt++) {
      var n = st.points[pt - 1]; if (!n) continue;
      var who = n > 0 ? 0 : 1, c = Math.abs(n), q = place(pt, me), shown = Math.min(c, 5);
      for (var i = 0; i < shown; i++) {
        var cy = q.top ? 8 + 12 + i * 21 : 292 - 12 - i * 21;
        s.push(checker(q.x, cy, who, sel === pt && i === shown - 1));
      }
      if (c > 5) s.push('<text x="' + q.x + '" y="' + ((q.top ? 8 + 12 + 4 * 21 : 292 - 12 - 4 * 21) + 4) + '" text-anchor="middle" font-size="11" font-weight="700" fill="' + (who === 0 ? "#222" : "#fff") + '">' + c + "</text>");
    }
    // bar
    var mine = me, opp = 1 - me;
    s.push('<rect data-pt="bar" x="152" y="150" width="20" height="142" fill="transparent"/>');
    for (i = 0; i < Math.min(st.bar[mine], 4); i++) s.push(checker(BARX, 292 - 14 - i * 22, mine, sel === "bar" && i === Math.min(st.bar[mine], 4) - 1));
    for (i = 0; i < Math.min(st.bar[opp], 4); i++) s.push(checker(BARX, 8 + 14 + i * 22, opp, false));
    // off trays (right edge): my side at the bottom
    var offT = targets && targets.indexOf("off") >= 0;
    s.push('<rect x="318" y="8" width="22" height="130" rx="4" fill="#2d1a0c"/><rect data-pt="off" x="318" y="162" width="22" height="130" rx="4" fill="' + (offT ? "#2e7d4f" : "#2d1a0c") + '"/>');
    for (i = 0; i < st.off[mine]; i++) s.push('<rect x="321" y="' + (288 - i * 8) + '" width="16" height="6" rx="2" fill="' + (mine === 0 ? "#efe8d2" : "#26262b") + '" stroke="#000" stroke-opacity=".3"/>');
    for (i = 0; i < st.off[opp]; i++) s.push('<rect x="321" y="' + (12 + i * 8) + '" width="16" height="6" rx="2" fill="' + (opp === 0 ? "#efe8d2" : "#26262b") + '" stroke="#000" stroke-opacity=".3"/>');
    if (lastMove && typeof lastMove.to === "number") { var lp = place(lastMove.to, me); s.push('<circle cx="' + lp.x + '" cy="' + (lp.top ? 24 : 276) + '" r="4" fill="#ffd54a" class="bgl"/>'); }
    s.push("</svg>");
    return s.join("");
  }

  function who(b, fallback) { return b ? NG.nameOf(b) : fallback; }

  /** the board screen */
  function openBoard(gid, first) {
    var w = el('<div class="bgscr"></div>');
    var top = NG.topbar("تخته‌نرد", { right: svg("dots") }); w.appendChild(top);
    var body = el('<div class="bgbody"></div>'); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var v = first || null, sel = null, alive = true, tm = null, busy = false, lastV = 0, lastDice = "";

    function targets() {
      if (!v || !sel) return [];
      return v.legal.filter(function (m) { return String(m.from) === String(sel); }).map(function (m) { return m.to; });
    }
    function status() {
      if (v.status === "waiting") return "منتظر حریف…";
      if (v.status === "finished" || v.winner !== null) {
        var meWon = v.winner === v.me;
        return v.endedBy === "cancel" ? "میز بسته شد" : (meWon ? "🏆 تو بردی!" : "باختی") + (v.endedBy === "resign" ? " (انصراف)" : v.endedBy === "timeout" ? " (وقت تموم شد)" : "");
      }
      if (v.canRoll) return "نوبت توئه — تاس بنداز";
      if (v.state.turn === v.me) return v.legal.length ? "نوبت توئه — مهره رو انتخاب کن" : "حرکتی نمونده…";
      return "نوبت حریفه…";
    }
    function playerBar(b, color, isTurn, off) {
      return '<div class="bgp' + (isTurn ? " turn" : "") + '"><span class="bgc c' + color + '"></span><b>' + esc(b ? NG.nameOf(b) : "…") + "</b>" + (b ? NG.vb(b) : "") + '<small>' + num(off) + "/۱۵ بیرون</small></div>";
    }
    function paint() {
      if (!v) return;
      var st = v.state, opp = v.me === 0 ? v.black : v.white, me = v.me === 0 ? v.white : v.black;
      var myTurn = v.status === "active" && st && st.turn === v.me && st.winner === null;
      var h = "";
      h += playerBar(opp, 1 - v.me, v.status === "active" && st && st.turn !== v.me && st.winner === null, st ? st.off[1 - v.me] : 0);
      if (!st) h += '<div class="bgwait"><div class="spin"></div><p>منتظر یه حریف…<br><small>میز تا ۱۵ دقیقه باز می‌مونه</small></p><button class="btn" id="cn">لغو میز</button></div>';
      else {
        h += '<div class="bgboard">' + boardSvg(v, sel, targets(), v.last && v.last.move) + "</div>";
        var dice = (st.remaining || []).slice(), shownDice = dice;
        if (!dice.length && v.last && v.last.dice && v.last.by === st.turn) shownDice = [];
        var dh = "";
        if (v.last && v.last.dice && (!st.remaining || st.remaining.length) ) { /* dice come from remaining below */ }
        (st.remaining || []).forEach(function (d) { dh += '<span class="die">' + PIPS[d] + "</span>"; });
        if (!dh && v.last && v.last.dice) v.last.dice.forEach(function (d) { dh += '<span class="die used">' + PIPS[d] + "</span>"; });
        h += '<div class="bgdice' + (lastDice !== JSON.stringify(st.remaining) ? " roll" : "") + '">' + dh + "</div>";
      }
      h += '<div class="bgstat">' + esc(status()) + "</div>";
      if (v.canRoll) h += '<button class="btn blue tall" id="rl" style="width:100%">🎲 بنداز</button>';
      if (v.idleLeft != null && v.status === "active") h += '<div class="bgidle">' + (myTurn ? "وقت تو: " : "وقت حریف: ") + num(Math.floor(v.idleLeft / 60)) + ":" + String(v.idleLeft % 60).padStart(2, "0") + "</div>";
      h += playerBar(me, v.me, myTurn, st ? st.off[v.me] : 0);
      if (v.status === "finished" || (st && st.winner !== null)) h += '<button class="btn blue tall" id="again" style="width:100%;margin-top:10px">بازی جدید</button>';
      body.innerHTML = h;
      if (st) lastDice = JSON.stringify(st.remaining);
      var rl = body.querySelector("#rl"); if (rl) rl.onclick = function () { act("game_roll", {}); };
      var cn = body.querySelector("#cn"); if (cn) cn.onclick = function () { act("game_resign", {}, true); };
      var ag = body.querySelector("#again"); if (ag) ag.onclick = function () { alive = false; scr.close(); NG.openGame(); };
      var svgEl = body.querySelector(".bgsvg");
      if (svgEl) svgEl.onclick = function (e) {
        var t = e.target.closest ? e.target.closest("[data-pt]") : null; if (!t || !myTurn || busy) return;
        var raw = t.getAttribute("data-pt"), pt = raw === "bar" || raw === "off" ? raw : Number(raw);
        var tg = targets();
        if (sel !== null && tg.indexOf(pt) >= 0) {
          var mv = v.legal.filter(function (m) { return String(m.from) === String(sel) && m.to === pt; });
          // several dice reach the same point: use the larger first (the server accepts any legal die)
          mv.sort(function (a, b) { return b.die - a.die; });
          var m0 = mv[0]; sel = null; act("game_move", { from: m0.from, to: m0.to, die: m0.die }); return;
        }
        var canFrom = v.legal.some(function (m) { return String(m.from) === String(pt); });
        if (canFrom && String(sel) !== String(pt)) { sel = pt; NG.haptic("sel"); paint(); } else { sel = null; paint(); }
      };
    }
    function apply(nv) {
      if (!nv || nv.unchanged) return;
      var changed = !v || nv.v !== v.v || nv.status !== v.status;
      v = nv; if (changed) { sel = null; if (!first || lastV) paint(); else paint(); lastV = nv.v; }
      else if (v && v.status === "active") { var d = body.querySelector(".bgidle"); if (d) d.textContent = (v.state.turn === v.me ? "وقت تو: " : "وقت حریف: ") + num(Math.floor(v.idleLeft / 60)) + ":" + String(v.idleLeft % 60).padStart(2, "0"); }
    }
    function act(action, extra, closeAfter) {
      if (busy) return; busy = true;
      var b = { gid: gid }; for (var k in extra) b[k] = extra[k];
      NG.api(action, b).then(function (r) {
        busy = false;
        if (!r.ok) { NG.haptic("err"); NG.toast(NG.errText(r)); sel = null; poll(); return; }
        NG.haptic("sel"); apply(r.data); if (closeAfter) { alive = false; scr.close(); }
      }).catch(function () { busy = false; NG.netErr(); });
    }
    function poll() {
      if (!alive) return;
      NG.api("game_state", { gid: gid, since: v ? v.v : undefined }).then(function (r) {
        if (!alive) return;
        if (!r.ok) { if (r.status === 404) { NG.toast("این بازی دیگه وجود نداره."); alive = false; scr.close(); } return; }
        apply(r.data);
      }).catch(function () {});
    }
    function loop() { if (!alive) return; if (!document.body.contains(w)) { alive = false; return; } if (!document.hidden && !busy) poll(); tm = setTimeout(loop, 1500); }
    top.querySelector(".rt").onclick = function () {
      if (!v || v.status === "finished") return;
      NG.actions([{ label: v.status === "waiting" ? "لغو میز" : "انصراف از بازی", cls: "red", fn: function () { NG.confirm(v.status === "waiting" ? "لغو میز؟" : "انصراف؟", v.status === "waiting" ? "میز بسته می‌شه." : "بازی رو می‌بازی.", "تأیید", function () { act("game_resign", {}); }); } }]);
    };
    paint(); loop();
  }

  /** lobby: continue my game / create a table / join an open one */
  NG.openGame = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("تخته‌نرد 🎲"); w.appendChild(top);
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var alive = true;
    function enter(r) { if (!r.ok) return NG.toast(NG.errText(r)); alive = false; scr.close(); setTimeout(function () { openBoard(r.data.gid, r.data); }, 60); }
    function load() {
      NG.api("game_lobby").then(function (r) {
        if (!alive) return;
        body.className = ""; body.innerHTML = "";
        if (!r.ok) return NG.toast(NG.errText(r));
        var d = r.data;
        body.appendChild(el('<div class="bghero"><div class="bgbig">🎲</div><h3>تخته‌نرد دو نفره</h3><p>با یه کاربر دیگه‌ی نوا گرام بازی کن. هر نفر ۵ دقیقه وقت داره هر حرکت رو بزنه.</p></div>'));
        if (d.mine) {
          var c = el('<button class="btn blue tall" style="width:calc(100% - 28px);margin:6px 14px">' + (d.mine.status === "waiting" ? "برگشت به میزت" : "ادامه‌ی بازی") + "</button>");
          c.onclick = function () { alive = false; scr.close(); setTimeout(function () { openBoard(d.mine.gid, null); }, 60); };
          body.appendChild(c);
        } else {
          var n = el('<button class="btn blue tall" style="width:calc(100% - 28px);margin:6px 14px">ساخت میز جدید</button>');
          n.onclick = function () { n.disabled = true; NG.api("game_create").then(enter).catch(function () { n.disabled = false; NG.netErr(); }); };
          body.appendChild(n);
          body.appendChild(el('<div class="hint"><span>میزهای باز</span></div>'));
          if (!d.open.length) body.appendChild(el('<div class="empty" style="padding:26px">الان میز بازی نیست؛ خودت یکی بساز.</div>'));
          d.open.forEach(function (t) {
            var r2 = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(t.host)) + NG.vb(t.host) + "</b><span>" + NG.ago(t.at) + '</span></div><button class="fbtn">بپیوند</button></div>');
            var rg = NG.ring(t.host, { noStory: true }); rg.className = "ring none"; r2.insertBefore(rg, r2.firstChild);
            r2.querySelector("button").onclick = function (e) { e.stopPropagation(); NG.api("game_join", { gid: t.gid }).then(function (rr) { if (!rr.ok) { NG.toast(rr.data && rr.data.error === "not_found" ? "این میز دیگه نیست." : NG.errText(rr)); return load(); } enter(rr); }).catch(NG.netErr); };
            body.appendChild(r2);
          });
        }
      }).catch(NG.netErr);
    }
    load();
    (function loop() { setTimeout(function () { if (!alive || !document.body.contains(w)) return; if (!document.hidden) load(); loop(); }, 4000); })();
  };
})();
