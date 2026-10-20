/* نوا گرام — main: shell, floating tab bar, explore (all users), search, own profile tab, deep links, boot. */
(function () {
  "use strict";
  var NG = window.NG, $ = NG.$, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  /* ------------------------------------------------------------------ shell */
  var TABS = ["home", "explore", "match", "search", "profile"];
  var ORDER = ["profile", "search", "match", "explore", "home"]; // rendered LTR => Home sits on the right (RTL feel)
  var pages = (NG.pages = {}), current = "home", tabbar, pill, scrollAt = {};
  var profileV = null, matchV = null;

  function buildShell() {
    NG.col.innerHTML = "";
    TABS.forEach(function (t) { var p = el('<div class="tabpage" id="pg-' + t + '"></div>'); pages[t] = p; NG.col.appendChild(p); });
    tabbar = el('<nav class="tabbar" id="tabbar"><div class="pill" id="pill"></div></nav>');
    ORDER.forEach(function (t) {
      var b = el('<button class="tab" data-tab="' + t + '" aria-label="' + t + '"></button>');
      if (t === "profile") b.innerHTML = '<div class="av" id="tabav"></div>';
      else b.innerHTML = '<span class="o">' + svg(t + "O", "") + '</span><span class="f">' + svg(t + "F", "") + "</span>";
      b.addEventListener("click", function () { NG.selectTab(t, true); });
      tabbar.appendChild(b);
    });
    NG.col.appendChild(tabbar);
    pill = $("pill");
    window.addEventListener("resize", movePill);
    setTabAvatar();
  }
  function setTabAvatar() {
    var a = $("tabav"); if (!a) return;
    a.style.backgroundImage = NG.me && NG.me.av ? "url('" + NG.me.av + "')" : "";
    if (!(NG.me && NG.me.av)) a.innerHTML = svg("user", ""); else a.innerHTML = "";
    var s = a.firstChild && a.firstChild.style; if (s) { s.width = "100%"; s.height = "100%"; s.padding = "3px"; }
  }
  /** The pill is placed in pixels from the real tab button, so it can never stick out of the bar or drift off the icon. */
  function movePill() {
    if (!tabbar || !pill) return;
    var b = tabbar.querySelector('.tab[data-tab="' + current + '"]'); if (!b) return;
    var w = Math.max(0, b.offsetWidth - 10);
    pill.style.width = w + "px";
    pill.style.transform = "translateX(" + (b.offsetLeft + 5) + "px)";
    Array.prototype.forEach.call(tabbar.querySelectorAll(".tab"), function (x) { x.classList.toggle("on", x.getAttribute("data-tab") === current); });
  }

  NG.onScreens = function (n) { if (tabbar) tabbar.classList.toggle("away", n > 0); };

  NG.selectTab = function (t, user) {
    // not registered in the bot yet: only the Matching preview is open; everything else says "register first"
    if (NG.guest && t !== "match") { NG.haptic("err"); NG.toast("ابتدا ثبت‌نام کنید"); return; }
    if (user) NG.haptic("sel");
    var pg = pages[t];
    if (t === current && user) {
      if (pg.scrollTop > 4) pg.scrollTo({ top: 0, behavior: "smooth" });
      else if (t === "home") NG.refresh();
      else if (t === "explore") loadExplore(true);
      else if (t === "search") { var i = pg.querySelector("input"); if (i) i.focus(); }
      else if (t === "profile" && profileV) profileV.reload();
      return;
    }
    scrollAt[current] = pages[current].scrollTop;
    current = t;
    TABS.forEach(function (k) { pages[k].classList.toggle("on", k === t); });
    pg.scrollTop = scrollAt[t] || 0;
    movePill();
    if (t === "explore" && !expl.loaded && !expl.loading) loadExplore(true);
    if (t === "match") { if (!matchV) matchV = NG.matchView(pages.match); else matchV.reload(); }
    if (t === "search") renderSearch(true);
    if (t === "profile") { renderProfileTab(); }
  };

  /* ------------------------------------------------------------ own profile */
  function renderProfileTab() {
    if (!profileV) {
      profileV = NG.profileView(NG.me.id, { tab: true });
      pages.profile.innerHTML = ""; pages.profile.appendChild(profileV.node);
    }
    profileV.reload();
  }

  /* ---------------------------------------------------------------- explore */
  var expl = { items: [], next: 0, more: true, loading: false, loaded: false };
  function tileFor(u) {
    var t = el('<div class="tile sk"></div>');
    var src = u.src || u.tileSrc;
    if (src) t.appendChild(NG.img(src));
    else { t.classList.remove("sk"); t.appendChild(el('<div class="ph0">' + esc(String(NG.nameOf(u) || "؟").charAt(0).toUpperCase()) + "</div>")); }
    t.appendChild(el('<div class="cnt">' + esc(NG.nameOf(u)) + "</div>"));
    t.onclick = function () { NG.haptic("sel"); NG.openProfile(u.id); };
    return t;
  }
  function renderExploreShell() {
    var pg = pages.explore; pg.innerHTML = "";
    var sp = el('<button class="searchpill">' + svg("searchO", "") + "<span>جستجو</span></button>");
    sp.onclick = function () { NG.selectTab("search", true); };
    var top = el('<div style="position:sticky;top:0;z-index:5;background:var(--bg);padding-top:6px"></div>'); top.appendChild(sp);
    pg.appendChild(top);
    pg.appendChild(el('<div class="grid" id="xgrid"></div>'));
    pg.appendChild(el('<div class="more-spin hide" id="xspin"><div class="spin"></div></div>'));
    pg.appendChild(el('<div id="xend" style="height:2px"></div>'));
    if ("IntersectionObserver" in window) new IntersectionObserver(function (en) { if (en[0].isIntersecting && expl.loaded && expl.more) loadExplore(false); }, { root: pg, rootMargin: "600px 0px" }).observe($("xend"));
  }
  function loadExplore(reset) {
    if (expl.loading) return;
    expl.loading = true;
    if (reset) { expl.next = 0; expl.more = true; }
    var grid = $("xgrid"), spin = $("xspin");
    if (reset && !expl.loaded) grid.innerHTML = new Array(13).join('<div class="tile sk"></div>');
    else if (spin) spin.classList.remove("hide");
    NG.api("explore", { offset: expl.next }).then(function (r) {
      expl.loading = false; if (spin) spin.classList.add("hide");
      if (!r.ok) { if (reset && !expl.loaded) grid.innerHTML = ""; return NG.fail(r); }
      if (reset) grid.innerHTML = "";
      expl.loaded = true;
      r.data.items.forEach(function (u) { grid.appendChild(tileFor(u)); });
      expl.next = r.data.next; expl.more = r.data.hasMore;
      if (!grid.children.length) grid.outerHTML = NG.emptyHtml("exploreO", "هنوز کسی اینجا نیست", "");
    }).catch(function () { expl.loading = false; if (spin) spin.classList.add("hide"); NG.netErr(); });
  }

  /* ----------------------------------------------------------------- search */
  var searchSeq = 0, searchT = null, searchBuilt = false;
  function userRow(u, o) {
    o = o || {};
    var r = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(u)) + NG.vb(u) + "</b><span>" + (u.username ? esc(u.name) : "") + "</span></div></div>");
    r.insertBefore(NG.ring(u), r.firstChild);
    r.querySelector(".ring").onclick = function (e) { if (u.story) { e.stopPropagation(); NG.openStories([u.id], 0); } };
    r.onclick = function () { NG.api("recent_add", { id: u.id }); NG.openProfile(u.id); };
    if (o.removable) {
      var x = el('<button class="rm" aria-label="remove">' + svg("close", "") + "</button>");
      x.onclick = function (e) { e.stopPropagation(); NG.api("recent_remove", { id: u.id }); r.remove(); var box = $("sres"); if (box && !box.querySelector(".row")) searchQuery(""); };
      r.appendChild(x);
    }
    return r;
  }
  function renderSearch(focus) {
    var pg = pages.search;
    if (!searchBuilt) {
      searchBuilt = true; pg.innerHTML = "";
      var bar = el('<div class="sbar"><div class="field">' + svg("searchO", "") + '<input type="text" placeholder="جستجو" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40"><button class="x hide" aria-label="clear">' + svg("close", "") + "</button></div></div>");
      pg.appendChild(bar); pg.appendChild(el('<div id="sres"></div>'));
      var inp = bar.querySelector("input"), x = bar.querySelector(".x");
      inp.oninput = function () {
        x.classList.toggle("hide", !inp.value);
        clearTimeout(searchT); searchT = setTimeout(function () { searchQuery(inp.value); }, 240);
      };
      x.onclick = function () { inp.value = ""; x.classList.add("hide"); searchQuery(""); inp.focus(); };
      inp.onkeydown = function (e) { if (e.key === "Enter") { clearTimeout(searchT); searchQuery(inp.value); inp.blur(); } };
      searchQuery("");
    } else if (!pages.search.querySelector("input").value) searchQuery("");
    if (focus) { var i = pg.querySelector("input"); setTimeout(function () { try { i.focus(); } catch (e) {} }, 60); }
  }
  function searchQuery(q) {
    var box = $("sres"); if (!box) return;
    var my = ++searchSeq, query = q.trim();
    if (query) box.innerHTML = '<div class="more-spin"><div class="spin"></div></div>';
    NG.api("search", { q: query }).then(function (r) {
      if (my !== searchSeq) return;
      box.innerHTML = "";
      if (!r.ok) return NG.fail(r);
      var items = r.data.items;
      if (r.data.recent) {
        if (!items.length) { box.innerHTML = '<div class="empty" style="padding:50px 30px">اسم یا یوزرنیم یه نفر رو بنویس تا پیداش کنم.</div>'; return; }
        var h = el('<div class="hint"><span>اخیر</span><button>پاک کردن همه</button></div>');
        h.querySelector("button").onclick = function () { NG.api("recent_clear"); box.innerHTML = '<div class="empty" style="padding:50px 30px">اسم یا یوزرنیم یه نفر رو بنویس تا پیداش کنم.</div>'; };
        box.appendChild(h);
        items.forEach(function (u) { box.appendChild(userRow(u, { removable: true })); });
      } else {
        if (!items.length) { box.innerHTML = '<div class="empty" style="padding:50px 30px"><h3 style="font-size:18px">نتیجه‌ای پیدا نشد</h3>یوزرنیم یا نام دیگه‌ای رو امتحان کن.</div>'; return; }
        items.forEach(function (u) { box.appendChild(userRow(u)); });
      }
    }).catch(function () { if (my === searchSeq) { box.innerHTML = ""; NG.netErr(); } });
  }

  /* ----------------------------------------------------- me / live updates */
  var pollT = null;
  function needsPoll() { var m = NG.me; return !!(m && (m.photoPending || m.pendingName || m.pendingAge)); }
  function schedulePoll() {
    clearTimeout(pollT);
    if (!needsPoll()) return;
    pollT = setTimeout(function () { if (document.hidden) return schedulePoll(); NG.refreshMe().then(schedulePoll, schedulePoll); }, 9000);
  }
  NG.on("me", function (d) {
    var o = d.old, m = d.me;
    setTabAvatar();
    if (o && m && profileV && o.relic !== m.relic) profileV.setRelic(m.relic);
    if (o && m && (o.av !== m.av || o.name !== m.name || o.age !== m.age || o.username !== m.username || o.bio !== m.bio || !!o.photoPending !== !!m.photoPending || o.pendingName !== m.pendingName || o.pendingAge !== m.pendingAge)) {
      if (profileV) profileV.reload();
      if (o.av !== m.av) { NG.refresh(); NG.refreshTray(); }
      if (o.photoPending && !m.photoPending && o.av === m.av) NG.toast("درخواست عکس پروفایل بررسی شد.");
      if (o.av !== m.av) NG.toast("✅ عکس پروفایلت عوض شد");
    }
    schedulePoll();
  });
  /* Live pulse (every few seconds while the app is visible): activity badge, coins, follow requests. One tiny request. */
  var pulseT = null, pulsing = false;
  function pulse() {
    clearTimeout(pulseT);
    if (document.hidden || !NG.me || pulsing) { pulseT = setTimeout(pulse, 6000); return; }
    pulsing = true;
    NG.api("pulse").then(function (r) {
      pulsing = false;
      if (r.ok) applyPulse(r.data);
    }).catch(function () { pulsing = false; }).then(function () { clearTimeout(pulseT); pulseT = setTimeout(pulse, 6000); });
  }
  function applyPulse(d) {
    var m = NG.me; if (!m) return;
    if (d.sig != null) { if (NG.sigSeen != null && NG.sigSeen !== d.sig) NG.refreshMe(); NG.sigSeen = d.sig; }
    if (d.relic != null && d.relic !== m.relic) { m.relic = d.relic; if (profileV) profileV.setRelic(d.relic); }
    if ((d.requests || 0) !== (m.requests || 0) || !!d.isPrivate !== !!m.isPrivate) {
      m.requests = d.requests || 0; m.isPrivate = !!d.isPrivate;
      if (profileV) profileV.reload();
    }
    NG.setPulse(d.unread);
  }
  NG.pulse = pulse;
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && NG.me) { NG.refreshMe(); NG.refreshTray(); pulse(); }
  });
  NG.on("follow", function () { if (profileV && current === "profile") profileV.reload(); });

  /* -------------------------------------------------------------- deep links */
  function deepLink() {
    var sp = "";
    try { sp = (NG.tg && NG.tg.initDataUnsafe && NG.tg.initDataUnsafe.start_param) || NG.qs.get("tgWebAppStartParam") || NG.qs.get("go") || ""; } catch (e) {}
    var m = /^([pqu])_([A-Za-z0-9_-]{1,64})$/.exec(sp);
    if (!m) return;
    setTimeout(function () {
      if (m[1] === "p") NG.openPost(m[2]);
      else if (m[1] === "q") NG.openPost("pp:" + m[2]);
      else NG.openProfile(m[2]);
    }, 350);
  }

  function actBanner() {
    var b = document.createElement("div"); b.className = "actasbar";
    b.innerHTML = '<span>🎭 داری به‌جای «' + NG.esc(NG.me.name || NG.me.id) + '» کار می‌کنی</span><button type="button">بازگشت به اکانت خودم</button>';
    b.querySelector("button").onclick = function () { NG.setActAs(null); location.reload(); };
    document.body.appendChild(b);
  }

  /* -------------------------------------------------------------------- boot */
  function boot() {
    var t0 = Date.now();
    function reveal() { var wait = Math.max(0, 1500 - (Date.now() - t0)); setTimeout(NG.hideSplash, wait); }
    if (!NG.initData) { NG.fatal("مینی‌اپ رو از داخل تلگرام باز کن", "دکمه‌ی مینی‌اپ داخل ربات رو بزن."); return; }
    NG.splashProgress(30);
    NG.api("whoami").then(function (r) {
      NG.splashProgress(60);
      if (!r.ok) {
        var er = r.data && r.data.error;
        if (NG.actAs && (er === "not_found" || er === "forbidden" || er === "not_registered")) { NG.setActAs(null); location.reload(); return; }
        if (er === "not_registered") {
          // guest preview: Matching tab with 5 fictional-member cards, nothing else
          NG.guest = true; NG.me = null; buildShell();
          NG.selectTab("match"); reveal(); return;
        }
        NG.fail(r); return;
      }
      if (r.data.role === "staff") { location.replace("/monitor/"); return; }
      NG.me = r.data.me; NG.bot = r.data.bot || null; NG.staff = !!r.data.staff; // owner / admins may remove any post, story or comment
      buildShell(); renderExploreShell();
      if (r.data.acting) actBanner();
      pages.home.classList.add("on"); movePill();
      NG.splashProgress(80);
      var done = NG.renderHome(pages.home);
      var fin = function () { reveal(); deepLink(); schedulePoll(); pulse(); };
      if (done && done.then) done.then(fin, fin); else fin();
      setTimeout(movePill, 120);
    }).catch(function () { NG.fatal("اتصال برقرار نیست", "اینترنتت رو چک کن و دوباره باز کن."); });
  }
  boot();
})();
