/* مویاگرام — Directs: the messages tab (chats + requests inbox) and the chat screen. Chats started inside the app stay inside the app;
   anonymous bot chats are only announced here (they stay anonymous). Polling keeps everything in sync within ~2 seconds. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  function rid() { return "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function hm(ms) { try { return new Date(ms).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function preview(l) { if (!l) return "چت شروع شد"; if (l.kind === "photo") return (l.mine ? "شما: " : "") + "📷 عکس"; if (l.kind === "system") return l.text || "—"; return (l.mine ? "شما: " : "") + (l.text || "پیام حذف شد"); }

  /* ------------------------------------------------------------------ tab */
  NG.dmView = function (page) {
    var root = el('<div class="dmv"></div>'); page.innerHTML = ""; page.appendChild(root);
    var data = null, timer = null, loading = false, CK = "ng_dm_" + (NG.me ? NG.me.id : "x");
    try { var c = JSON.parse(localStorage.getItem(CK) || "null"); if (c && c.items && c.requests) data = c; } catch (e) {} // instant first paint, refreshed right after

    function paint() {
      root.innerHTML = "";
      var top = el('<div class="topbar"><div class="ttlx">پیام‌ها</div><div class="icons"><button id="reqb" aria-label="requests" class="reqb">' + svg("user") + '<i class="dot hide"></i></button></div></div>');
      root.appendChild(top);
      var inc = data ? data.requests.incoming : 0, out = data ? data.requests.outgoing : 0;
      var dot = top.querySelector(".dot"); if (inc > 0) dot.classList.remove("hide");
      top.querySelector("#reqb").onclick = function () { NG.openDmRequests(); };
      if (!data) { root.appendChild(el('<div class="more-spin"><div class="spin"></div></div>')); return; }
      if (inc > 0 || out > 0) {
        var rb = el('<button class="dmreq">' + svg("chat", "") + "<span>درخواست‌های چت" + (inc ? " · " + num(inc) + " جدید" : "") + (out ? " · " + num(out) + " ارسال‌شده" : "") + "</span></button>");
        rb.onclick = function () { NG.openDmRequests(); };
        root.appendChild(rb);
      }
      if (data.botChat) root.appendChild(el('<div class="dmbot">🕵️ یه چت ناشناس توی ربات داری؛ اون چت همون‌جا (ناشناس) ادامه پیدا می‌کنه.</div>'));
      if (!data.items.length) { root.appendChild(el(NG.emptyHtml("plane", "هنوز چتی نداری", "از پروفایل یا مچینگ برای یه نفر «درخواست چت» بفرست. اگه قبول کنه، همین‌جا چت می‌کنید."))); return; }
      data.items.forEach(function (t) {
        var nm = t.partner ? NG.nameOf(t.partner) : "کاربر";
        var r = el('<div class="row dmrow' + (t.unread ? " unread" : "") + '"><div class="t"><b>' + esc(nm) + (t.partner ? NG.vb(t.partner) : "") + '</b><span>' + esc(t.active ? preview(t.last) : "چت تموم شده") + '</span></div><div class="dmr"><small>' + (t.last ? NG.ago(t.last.at) : "") + "</small>" + (t.unread ? '<i class="ub">' + num(t.unread) + "</i>" : "") + (t.active ? "" : '<em class="end">پایان</em>') + "</div></div>");
        var rg = t.partner ? NG.ring(t.partner, { noStory: true }) : el('<div class="ring none"><div class="in">' + svg("user", "") + "</div></div>"); rg.className = "ring none"; r.insertBefore(rg, r.firstChild);
        r.onclick = function () { NG.openChat(t.sid, t.partner); };
        root.appendChild(r);
      });
    }
    function load() {
      if (loading) return; loading = true;
      NG.api("dm_overview").then(function (r) {
        loading = false;
        if (!r.ok) { if (!data) NG.fail(r); return; }
        data = r.data; try { localStorage.setItem(CK, JSON.stringify(data)); } catch (e) {}
        NG.setDmBadge(data.requests.incoming + data.items.reduce(function (n, x) { return n + (x.unread || 0); }, 0));
        if (page.classList.contains("on") && !document.querySelector(".chatscr")) paint();
      }).catch(function () { loading = false; });
    }
    function loop() { clearTimeout(timer); if (!document.hidden && page.classList.contains("on") && !document.querySelector(".screen")) load(); timer = setTimeout(loop, 4000); }
    paint(); load(); loop();
    NG.on("dm:changed", load);
    return { reload: function () { load(); paint(); } };
  };

  /* ------------------------------------------------------------- requests */
  NG.openDmRequests = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("درخواست‌های چت"); w.appendChild(top);
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var alive = true, tm = null;
    NG.addLayer && void 0;

    function head(t) { return el('<div class="hint"><span>' + t + "</span></div>"); }
    function left(ms, at) { var m = Math.max(0, Math.floor((Date.now() - (at || Date.now())) / 60000)); return m < 1 ? "همین الان" : m < 60 ? num(m) + " دقیقه پیش" : m < 1440 ? num(Math.floor(m / 60)) + " ساعت پیش" : num(Math.floor(m / 1440)) + " روز پیش"; }
    function row(it, incoming) {
      var r = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(it.who)) + NG.vb(it.who) + "</b><span>" + left(it.expiresAt, it.at) + '</span></div><div class="rq"></div></div>');
      var rg = NG.ring(it.who, { noStory: true }); rg.className = "ring none"; r.insertBefore(rg, r.firstChild);
      rg.onclick = function (e) { e.stopPropagation(); NG.openProfile(it.who.id); };
      var box = r.querySelector(".rq");
      if (incoming) {
        var ok = el('<button class="fbtn">قبول</button>'), no = el('<button class="fbtn gray">رد</button>');
        function answer(acc) {
          ok.disabled = no.disabled = true;
          NG.api("dm_respond", { id: it.id, accept: acc }).then(function (rr) {
            ok.disabled = no.disabled = false;
            if (!rr.ok) return NG.toast(NG.errText(rr));
            var s = rr.data.status;
            if (s === "accepted") { NG.haptic("ok"); NG.emit("dm:changed"); r.remove(); if (rr.data.origin === "miniapp") { scr.close(); NG.selectTab("dm"); NG.openChat(rr.data.sid, it.who); } else NG.toast("چت توی ربات شروع شد ✓"); }
            else if (s === "declined") { r.remove(); NG.emit("dm:changed"); }
            else { NG.toast(s === "busy" ? "یکی از شما توی چت دیگه‌ای هست." : s === "blocked" ? "این کاربر در دسترس نیست." : s === "insufficient_me" ? "ژتون کافی نداری (۱ ژتون لازمه)." : s === "insufficient_other" ? "ژتون طرف مقابل کافی نیست." : "این درخواست دیگه معتبر نیست."); load(); }
          }).catch(function () { ok.disabled = no.disabled = false; NG.netErr(); });
        }
        ok.onclick = function () { answer(true); }; no.onclick = function () { answer(false); };
        box.appendChild(ok); box.appendChild(no);
      } else {
        var c = el('<button class="fbtn gray">لغو</button>');
        c.onclick = function () { c.disabled = true; NG.api("dm_cancel", { id: it.id }).then(function (rr) { if (!rr.ok) { c.disabled = false; return NG.toast(NG.errText(rr)); } r.remove(); NG.emit("dm:changed"); }).catch(function () { c.disabled = false; NG.netErr(); }); };
        box.appendChild(c);
      }
      return r;
    }
    function load() {
      NG.api("dm_requests").then(function (r) {
        body.className = ""; body.innerHTML = "";
        if (!r.ok) return NG.toast(NG.errText(r));
        var inc = r.data.incoming, out = r.data.outgoing;
        if (!inc.length && !out.length) { body.innerHTML = NG.emptyHtml("chat", "درخواستی نیست", "هر درخواستی که برات بیاد اینجا می‌مونه."); return; }
        if (inc.length) { body.appendChild(head("دریافتی")); inc.forEach(function (x) { body.appendChild(row(x, true)); }); }
        if (out.length) { body.appendChild(head("ارسال‌شده")); out.forEach(function (x) { body.appendChild(row(x, false)); }); }
      }).catch(NG.netErr);
    }
    load();
    (function poll() { tm = setTimeout(function () { if (!alive) return; if (!document.body.contains(w)) { alive = false; return; } if (!document.hidden && !document.querySelector(".sheet")) load(); poll(); }, 5000); })();
  };

  /* ----------------------------------------------------------------- chat */
  NG.openChat = function (sid, partner) {
    var w = el('<div class="chatscr"></div>');
    var title = partner ? NG.nameOf(partner) : "چت";
    var top = el('<div class="top"><button class="bk" aria-label="back">' + svg("back") + '</button><div class="ttl chtt"></div><button class="rt" aria-label="more">' + svg("dots") + "</button></div>");
    top.querySelector(".chtt").innerHTML = '<span>' + esc(title) + "</span>" + (partner ? NG.vb(partner) : "");
    var list = el('<div class="chlist"></div>');
    var bar = el('<div class="chbar"><button class="cp" aria-label="photo">' + svg("camera") + '</button><textarea rows="1" maxlength="1000" placeholder="پیام…"></textarea><button class="cs hide" aria-label="send">' + svg("plane") + '</button></div>');
    w.appendChild(top); w.appendChild(list); w.appendChild(bar);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    top.querySelector(".chtt").onclick = function () { if (partner) NG.openProfile(partner.id); };
    var msgs = {}, order = [], last = 0, theirRead = 0, active = true, ro = false, gone = false, tm = null, alive = true, firstLoad = true, pend = [];
    var inp = bar.querySelector("textarea"), snd = bar.querySelector(".cs"), cp = bar.querySelector(".cp");

    function nearBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight < 120; }
    function toBottom() { list.scrollTop = list.scrollHeight; }
    function bubble(m) {
      var b = el('<div class="mg ' + (m.kind === "system" ? "sys" : m.mine ? "me" : "th") + '" data-s="' + m.seq + '"></div>');
      if (m.kind === "system") { b.textContent = m.text || ""; return b; }
      var inner = el('<div class="bb"></div>');
      if (m.deleted) { inner.classList.add("del"); inner.textContent = "این پیام حذف شد"; }
      else if (m.kind === "photo") {
        inner.classList.add("ph"); var im = NG.img(m.src); inner.appendChild(im);
        inner.onclick = function () { if (m.src && NG.viewAvatar) NG.viewAvatar({ av: m.src }); };
      } else inner.textContent = m.text || "";
      b.appendChild(inner);
      var meta = el('<div class="mm"><span>' + hm(m.at) + "</span>" + (m.mine ? '<i class="tk' + (m.seq <= theirRead ? " rd" : "") + '">' + (m.seq <= theirRead ? "✓✓" : "✓") + "</i>" : "") + "</div>");
      b.appendChild(meta);
      return b;
    }
    function render(keepBottom) {
      var stick = keepBottom || nearBottom();
      list.innerHTML = "";
      if (!order.length && !pend.length && !ro) list.appendChild(el('<div class="chhint">چت شروع شد. سلام کن 👋</div>'));
      order.forEach(function (s) { list.appendChild(bubble(msgs[s])); });
      pend.forEach(function (p) { var b = bubble({ seq: 0, mine: true, kind: p.kind, text: p.text, src: p.src, at: p.at }); b.classList.add("sending"); b.querySelector(".tk") && (b.querySelector(".tk").textContent = "…"); list.appendChild(b); });
      if (!active) list.appendChild(el('<div class="chend">' + (gone ? "این کاربر در دسترس نیست." : "این چت تموم شده.") + "</div>"));
      if (ro) { bar.style.display = "none"; if (!list.querySelector(".chend")) list.appendChild(el('<div class="chend">این گفتگو فقط‌خواندنیه؛ امکان پاسخ دادن نیست.</div>')); }
      bar.classList.toggle("off", !active);
      inp.disabled = !active || ro; cp.disabled = !active || ro;
      if (stick) toBottom();
    }
    function merge(d) {
      if (d.messages) d.messages.forEach(function (m) { if (!msgs[m.seq]) order.push(m.seq); msgs[m.seq] = m; if (m.seq > last) last = m.seq; });
      order.sort(function (a, b) { return a - b; });
      theirRead = d.theirRead || 0; active = !!d.active; ro = !!d.readonly; gone = !!d.partnerGone;
      if (d.partner && !partner) { partner = d.partner; top.querySelector(".chtt").innerHTML = "<span>" + esc(NG.nameOf(partner)) + "</span>" + NG.vb(partner); }
    }
    var sig = "";
    function poll() {
      if (!alive) return;
      NG.api("dm_open", { sid: sid, since: last || undefined }).then(function (r) {
        if (!alive) return;
        if (!r.ok) { if (r.status === 404) { NG.toast("این چت دیگه وجود نداره."); scr.close(); } return; }
        var before = sig;
        merge(r.data);
        sig = order.length + ":" + last + ":" + theirRead + ":" + active + ":" + (r.data.messages || []).map(function (m) { return m.deleted ? "d" : "x"; }).join("");
        if (firstLoad || sig !== before) { render(firstLoad); firstLoad = false; }
        if (r.data.messages && r.data.messages.length) NG.emit("dm:changed");
      }).catch(function () {});
    }
    function loop() { if (!alive) return; if (!document.body.contains(w)) { alive = false; return; } if (!document.hidden) poll(); tm = setTimeout(loop, 2000); }
    var offLayer = scr.close;
    // stop polling when the screen closes
    var obs = new MutationObserver(function () { if (!document.body.contains(w)) { alive = false; clearTimeout(tm); obs.disconnect(); NG.emit("dm:changed"); } });
    obs.observe(NG.col, { childList: true });
    void offLayer;
    render(true); loop();

    /* sending (optimistic, safe to retry thanks to cid) */
    function addPend(p) { pend.push(p); render(true); }
    function dropPend(p) { var i = pend.indexOf(p); if (i >= 0) pend.splice(i, 1); }
    function done(p, m) { dropPend(p); if (m) { if (!msgs[m.seq]) order.push(m.seq); msgs[m.seq] = m; if (m.seq > last) last = m.seq; order.sort(function (a, b) { return a - b; }); } render(true); }
    function failed(p, r) {
      dropPend(p); render(true); NG.haptic("err");
      var e = r && r.data && r.data.error;
      if (e === "chat_ended") { active = false; render(true); return; }
      NG.toast(e === "contact_forbidden" ? "فرستادن آیدی/شماره/لینک تلگرام مجاز نیست." : e === "too_fast" ? "کمی آروم‌تر بفرست." : e === "text_too_long" ? "پیام خیلی طولانیه." : NG.errText(r));
    }
    function sendText() {
      var t = inp.value.trim(); if (!t || !active) return;
      var p = { kind: "text", text: t, at: Date.now(), cid: rid() }; inp.value = ""; grow(); addPend(p);
      NG.api("dm_send", { sid: sid, text: t, cid: p.cid }).then(function (r) { if (!r.ok) { inp.value = t; grow(); return failed(p, r); } done(p, r.data.message); }).catch(function () { dropPend(p); inp.value = t; grow(); render(true); NG.netErr(); });
    }
    function sendPhoto() {
      if (!active) return;
      NG.pickImage(function (f) {
        NG.fileToJpeg(f, 1280, function (d) {
          if (!d) return NG.toast(NG.errText({ data: { error: "bad_image" } }));
          var p = { kind: "photo", src: d, at: Date.now(), cid: rid() }; addPend(p);
          NG.api("dm_photo", { sid: sid, image: d, cid: p.cid }).then(function (r) { if (!r.ok) return failed(p, r); done(p, r.data.message); }).catch(function () { dropPend(p); render(true); NG.netErr(); });
        });
      });
    }
    function grow() { inp.style.height = "auto"; inp.style.height = Math.min(120, inp.scrollHeight) + "px"; snd.classList.toggle("hide", !inp.value.trim()); cp.classList.toggle("hide", !!inp.value.trim()); }
    inp.oninput = grow;
    inp.onfocus = function () { setTimeout(toBottom, 300); };
    inp.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); sendText(); } };
    snd.onclick = sendText; cp.onclick = sendPhoto;

    function delThread() {
      NG.confirm("حذف گفتگو؟", "این گفتگو فقط برای خودت پاک می‌شه.", "حذف", function () {
        NG.api("dm_delete", { sid: sid }).then(function (r) { if (!r.ok) return NG.toast(NG.errText(r)); NG.haptic("ok"); alive = false; scr.close(); NG.emit("dm:changed"); }).catch(NG.netErr);
      });
    }
    /* menu */
    top.querySelector(".rt").onclick = function () {
      var items = [];
      if (ro) { var ri = [{ label: "حذف گفتگو", cls: "red", fn: function () { delThread(); } }]; if (partner) ri.unshift({ label: "دیدن پروفایل", fn: function () { NG.openProfile(partner.id); } }); NG.actions(ri); return; }
      if (active) items.push({ label: "پایان چت", cls: "red", fn: function () {
        NG.confirm("پایان چت؟", "چت بسته می‌شه و هر دو نفر آزاد می‌شید.", "پایان چت", function () {
          NG.api("dm_end", { sid: sid }).then(function (r) { if (!r.ok) return NG.toast(NG.errText(r)); NG.haptic("ok"); active = false; render(true); NG.emit("dm:changed"); }).catch(NG.netErr);
        });
      } });
      if (!active) items.push({ label: "حذف گفتگو", cls: "red", fn: function () { delThread(); } });
      if (partner) {
        items.push({ label: "گزارش", cls: "red", fn: function () { NG.reportUser(partner); } });
        items.push({ label: "مسدود کردن", cls: "red", fn: function () { NG.blockUser(partner, function () { active = false; render(true); NG.emit("dm:changed"); }); } });
        items.push({ label: "دیدن پروفایل", fn: function () { NG.openProfile(partner.id); } });
      }
      if (items.length) NG.actions(items);
    };
  };

  /** red dot / number on the Directs tab */
  var badgeN = 0;
  NG.setDmBadge = function (n) {
    badgeN = n || 0;
    var b = document.querySelector('.tab[data-tab="dm"]'); if (!b) return;
    var i = b.querySelector(".tb");
    if (!badgeN) { if (i) i.remove(); return; }
    if (!i) { i = document.createElement("i"); i.className = "tb"; b.appendChild(i); }
    i.textContent = badgeN > 9 ? "9+" : num(badgeN);
  };
})();
