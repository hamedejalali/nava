/* Nava Mini App — Instagram-style client (v1.15.0). Vanilla JS, no build step. */
(function () {
  "use strict";
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = (tg && tg.initData) || "";
  var qs = new URLSearchParams(location.search);
  var light = false;
  try { light = tg && tg.colorScheme === "light"; } catch (e) {}
  if (qs.get("theme")) light = qs.get("theme") === "light";
  if (light) document.documentElement.setAttribute("data-theme", "light");
  if (tg) { try { tg.ready(); tg.expand(); var c = light ? "#ffffff" : "#000000"; tg.setHeaderColor(c); tg.setBackgroundColor(c); } catch (e) {} }

  var $ = function (id) { return document.getElementById(id); };
  var col = $("col");
  var ME = null;

  /* ------------------------------------------------------------ icons */
  var P = {
    homeO: '<path d="M9.005 16.545a2.997 2.997 0 0 1 2.997-2.997A2.997 2.997 0 0 1 15 16.545V22h7V11.543L12 2 2 11.543V22h7.005Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    homeF: '<path d="M22 23h-6.001a1 1 0 0 1-1-1v-5.455a2.997 2.997 0 1 0-5.993 0V22a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V11.543a1.002 1.002 0 0 1 .31-.724l10-9.543a1.001 1.001 0 0 1 1.38 0l10 9.543a1.002 1.002 0 0 1 .31.724V22a1 1 0 0 1-1 1Z" fill="currentColor"/>',
    exploreO: '<polygon fill="none" points="13.941 13.953 7.581 16.424 10.06 10.056 16.42 7.585 13.941 13.953" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/><polygon fill="currentColor" fill-rule="evenodd" points="10.06 10.056 13.941 13.953 7.581 16.424 10.06 10.056"/><circle cx="12.001" cy="12.005" fill="none" r="10.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>',
    exploreF: '<path d="M12 .5C5.649.5.5 5.649.5 12S5.649 23.5 12 23.5 23.5 18.351 23.5 12 18.351.5 12 .5Zm4.42 7.085a.5.5 0 0 1 .64.64l-2.6 6.66a.5.5 0 0 1-.29.29l-6.66 2.6a.5.5 0 0 1-.64-.64l2.6-6.66a.5.5 0 0 1 .29-.29Z" fill="currentColor" fill-rule="evenodd"/><path d="M10.06 10.056l3.881 3.897-6.36 2.471Z" fill="currentColor"/>',
    searchO: '<path d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="16.511" x2="22" y1="16.511" y2="22"/>',
    searchF: '<path d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" x1="16.511" x2="22" y1="16.511" y2="22"/>',
    heartO: '<path d="M16.792 3.904A4.989 4.989 0 0 1 21.5 9.122c0 3.072-2.652 4.959-5.197 7.222-2.512 2.243-3.865 3.469-4.303 3.752-.477-.309-2.143-1.823-4.303-3.752C5.141 14.072 2.5 12.167 2.5 9.122a4.989 4.989 0 0 1 4.708-5.218 4.21 4.21 0 0 1 3.675 1.941c.84 1.175.98 1.763 1.12 1.763s.278-.588 1.11-1.766a4.17 4.17 0 0 1 3.679-1.938m0-2a6.04 6.04 0 0 0-4.797 2.127 6.052 6.052 0 0 0-4.787-2.127A6.985 6.985 0 0 0 .5 9.122c0 3.61 2.55 5.827 5.015 7.97.283.246.569.494.853.747l1.027.918a44.998 44.998 0 0 0 3.518 3.018 2 2 0 0 0 2.174 0 45.263 45.263 0 0 0 3.626-3.115l.922-.824c.293-.26.59-.519.885-.774 2.334-2.025 4.98-4.32 4.98-7.94a6.985 6.985 0 0 0-6.708-7.218Z" fill="currentColor"/>',
    heartF: '<path d="M17.075 1.987a5.852 5.852 0 0 0-5.07 2.66l-.008.01-.002-.01a5.854 5.854 0 0 0-5.07-2.66A6.959 6.959 0 0 0 .5 9.122c0 3.61 2.55 5.827 5.015 7.97.283.246.569.494.853.747l1.027.918a44.998 44.998 0 0 0 3.518 3.018 2 2 0 0 0 2.174 0 45.263 45.263 0 0 0 3.626-3.115l.922-.824c.293-.26.59-.519.885-.774 2.334-2.025 4.98-4.32 4.98-7.94a6.959 6.959 0 0 0-6.425-7.135Z" fill="currentColor"/>',
    plane: '<line fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" x1="22" x2="9.218" y1="3" y2="10.083"/><polygon fill="none" points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    dots: '<circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>',
    plus: '<path d="M2 12v3.45c0 2.849.698 4.005 1.606 4.944.94.909 2.098 1.608 4.946 1.608h6.896c2.848 0 4.006-.7 4.946-1.608C21.302 19.455 22 18.3 22 15.45V8.552c0-2.849-.698-4.006-1.606-4.945C19.454 2.7 18.296 2 15.448 2H8.552c-2.848 0-4.006.699-4.946 1.607C2.698 4.547 2 5.703 2 8.552Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="6.545" x2="17.455" y1="12.001" y2="12.001"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="12.003" x2="12.003" y1="6.545" y2="17.455"/>',
    plusS: '<path d="M12 5v14M5 12h14" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3"/>',
    back: '<path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4" transform="scale(-1,1) translate(-24,0)"/>',
    chevD: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.6"/>',
    grid: '<rect fill="none" height="18" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" width="18" x="3" y="3"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="9.015" x2="9.015" y1="3" y2="21"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="14.985" x2="14.985" y1="3" y2="21"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="9.015" y2="9.015"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="14.985" y2="14.985"/>',
    pin: '<path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    user: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c.6-4.2 3.8-6.5 8-6.5s7.4 2.3 8 6.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>',
    cake: '<path d="M4 21V12h16v9M2 21h20M12 12V8M12 8c-1.2-1-1.2-2.4 0-3.6 1.2 1.2 1.2 2.6 0 3.6Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>',
    camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l1.3-2h8l1.3 2h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.9"/><circle cx="12" cy="13" r="3.7" fill="none" stroke="currentColor" stroke-width="1.9"/>'
  };
  var VERIFIED = '<svg class="verified" viewBox="0 0 40 40"><path d="M19.998 3.094 14.638 0l-2.972 5.15H5.432v6.354L0 14.64 3.094 20 0 25.359l5.432 3.137v5.905h5.975L14.638 40l5.36-3.094L25.358 40l3.232-5.6h6.162v-6.01L40 25.359 36.905 20 40 14.641l-5.248-3.03v-6.46h-6.419L25.358 0l-5.36 3.094Z" fill="#0095f6"/><path d="M28.452 14.97 17.4 26.02l-5.47-5.47" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function svg(name, cls) { return '<svg class="' + (cls || "ico") + '" viewBox="0 0 24 24" aria-hidden="true">' + P[name] + "</svg>"; }

  /* ----------------------------------------------------------- helpers */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); }
  function num(n) { try { return Number(n).toLocaleString("fa-IR"); } catch (e) { return String(n); } }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function haptic(k) { try { if (k === "sel") tg.HapticFeedback.selectionChanged(); else if (k === "ok") tg.HapticFeedback.notificationOccurred("success"); else if (k === "err") tg.HapticFeedback.notificationOccurred("error"); else tg.HapticFeedback.impactOccurred("light"); } catch (e) {} }
  var toastT;
  function toast(t) { var e = $("toast"); e.textContent = t; e.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { e.classList.remove("show"); }, 2600); }

  function api(action, body) {
    body = body || {}; body.action = action; body.initData = initData;
    if (qs.get("as") === "user") body.asUser = true;
    return fetch("/api/miniapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }

  /* -------------------------------------------------- photo (blob) cache */
  var photoCache = {}, queue = [], active = 0, ver = 0;
  function loadPhoto(id) {
    var key = id + ":" + ver;
    if (photoCache[key]) return photoCache[key];
    photoCache[key] = new Promise(function (resolve, reject) {
      queue.push({ id: id, resolve: resolve, reject: reject }); pump();
    });
    photoCache[key].catch(function () { delete photoCache[key]; });
    return photoCache[key];
  }
  function pump() {
    while (active < 4 && queue.length) {
      (function (job) {
        active++;
        fetch("/api/miniapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "photo", initData: initData, id: job.id }) })
          .then(function (r) { if (!r.ok) throw new Error("photo"); return r.blob(); })
          .then(function (b) { job.resolve(URL.createObjectURL(b)); })
          .catch(function (e) { job.reject(e); })
          .then(function () { active--; pump(); });
      })(queue.shift());
    }
  }
  var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var t = en.target; io.unobserve(t); fill(t);
    });
  }, { rootMargin: "400px 0px" }) : null;
  function fill(t) {
    var id = t.getAttribute("data-photo"); if (!id) return;
    loadPhoto(id).then(function (url) {
      if (t.tagName === "IMG") { t.onload = function () { t.classList.add("on"); if (t.parentNode) t.parentNode.classList.remove("sk"); }; t.src = url; }
      else { t.style.backgroundImage = "url(" + url + ")"; }
    }).catch(function () { if (t.parentNode) t.parentNode.classList.remove("sk"); });
  }
  function lazy(t) { if (io) io.observe(t); else fill(t); }
  function avatar(id, extraCls) {
    var d = el('<div class="in ' + (extraCls || "") + '"></div>');
    if (id) { d.setAttribute("data-photo", id); lazy(d); }
    return d;
  }

  /* ------------------------------------------------------------- state */
  var seenStories = {};
  var feed = { items: [], offset: 0, more: true, loading: false };
  var expl = { items: [], offset: 0, more: true, loading: false };
  var cards = {};
  function remember(list) { list.forEach(function (c) { cards[c.id] = c; }); }
  function fail(r) {
    var e = r.data && r.data.error;
    if (e === "join_required") return fatal("عضویت در کانال‌ها لازمه", "اول داخل کانال‌های ربات عضو شو، بعد دوباره مینی‌اپ رو باز کن.");
    if (e === "not_registered") return fatal("ثبت‌نام کامل نیست", "اول ثبت‌نام رو داخل ربات کامل کن (/start).");
    if (e === "banned") return fatal("دسترسی محدوده", "حساب شما اجازه‌ی استفاده از این بخش رو نداره.");
    if (r.status === 401) return fatal("مینی‌اپ رو از داخل تلگرام باز کن", "دکمه‌ی مینی‌اپ داخل ربات رو بزن.");
    toast("مشکلی پیش اومد. دوباره امتحان کن.");
  }
  function fatal(title, text) {
    col.innerHTML = '<div class="fatal"><h3>' + esc(title) + "</h3>" + esc(text) + "</div>";
    hideSplash();
  }
  function hideSplash() { var s = $("splash"); s.classList.add("gone"); setTimeout(function () { s.remove(); }, 400); }
  function displayName(c) { return c.username || c.name; }
  function place(c) { return c.city || c.province || ""; }

  /* ------------------------------------------------------------ shell */
  var tabs = ["home", "explore", "search", "profile"];
  var tabbar, pill, pages = {}, current = "home", stack = [];
  function buildShell() {
    col.innerHTML = "";
    tabs.forEach(function (t) { var p = el('<div class="tabpage" id="pg-' + t + '"></div>'); pages[t] = p; col.appendChild(p); });
    var order = ["profile", "search", "explore", "home"]; // rendered LTR => Home sits on the right (RTL feel)
    tabbar = el('<nav class="tabbar" id="tabbar"><div class="pill" id="pill"></div></nav>');
    order.forEach(function (t) {
      var b = el('<button class="tab" data-tab="' + t + '" aria-label="' + t + '"></button>');
      if (t === "profile") b.innerHTML = '<div class="av" id="tabav"></div>';
      else b.innerHTML = '<span class="o">' + svg(t + "O", "") + '</span><span class="f">' + svg(t + "F", "") + "</span>";
      b.addEventListener("click", function () { selectTab(t, true); });
      tabbar.appendChild(b);
    });
    col.appendChild(tabbar);
    pill = $("pill");
    var nb = el('<button class="nextbtn" id="nextbtn" aria-label="next">' + svg("chevD") + "</button>");
    nb.addEventListener("click", nextPost);
    col.appendChild(nb);
  }
  function movePill() {
    var order = ["profile", "search", "explore", "home"], i = order.indexOf(current);
    pill.style.transform = "translateX(" + (i * 100) + "%)";
    Array.prototype.forEach.call(tabbar.querySelectorAll(".tab"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === current); });
    $("nextbtn").classList.toggle("hide2", current !== "home");
  }
  function selectTab(t, user) {
    if (user) haptic("sel");
    if (t === current && user) {
      var pg = pages[t];
      if (pg.scrollTop > 4) pg.scrollTo({ top: 0, behavior: "smooth" });
      else if (t === "home") refreshFeed();
      else if (t === "explore") refreshExplore();
      else if (t === "search") { var i = pg.querySelector("input"); if (i) i.focus(); }
      return;
    }
    current = t;
    tabs.forEach(function (k) { pages[k].classList.toggle("on", k === t); });
    movePill();
    if (t === "explore" && !expl.items.length && !expl.loading) loadExplore();
    if (t === "search") renderSearch();
    if (t === "profile") renderProfile();
  }

  /* ----------------------------------------------------------- screens */
  function pushScreen(node, onPop) {
    var s = el('<div class="screen"></div>'); s.appendChild(node);
    col.appendChild(s); stack.push({ s: s, onPop: onPop });
    $("tabbar").classList.add("away");
    syncBack();
    return s;
  }
  function popScreen() {
    var top = stack.pop(); if (!top) return;
    top.s.classList.add("out");
    setTimeout(function () { top.s.remove(); }, 260);
    if (top.onPop) top.onPop();
    if (!stack.length) $("tabbar").classList.remove("away");
    syncBack();
  }
  function syncBack() {
    if (!tg || !tg.BackButton) return;
    try { if (stack.length) { tg.BackButton.show(); } else tg.BackButton.hide(); } catch (e) {}
  }
  if (tg && tg.BackButton) { try { tg.BackButton.onClick(function () { if (sheetClose) sheetClose(); else popScreen(); }); } catch (e) {} }

  var sheetClose = null;
  function openSheet(html, bind) {
    var dim = el('<div class="dim"></div>'), sh = el('<div class="sheet"><div class="grab"></div>' + html + "</div>");
    document.body.appendChild(dim); document.body.appendChild(sh);
    function close() { if (!sheetClose) return; sheetClose = null; sh.classList.add("down"); dim.style.opacity = 0; dim.style.transition = "opacity .2s"; setTimeout(function () { sh.remove(); dim.remove(); }, 230); }
    sheetClose = close; dim.addEventListener("click", close);
    if (bind) bind(sh, close);
    return close;
  }

  /* -------------------------------------------------------------- post */
  function likesText(c) { return c.likes ? num(c.likes) + " لایک" : "اولین نفری باش که لایک می‌کنه"; }
  function postEl(c, opts) {
    opts = opts || {};
    var p = el('<article class="post" data-pid="' + esc(c.id) + '"></article>');
    var head = el('<div class="ph"></div>');
    var ring = el('<div class="ring ' + (seenStories[c.id] ? "seen" : "") + '"></div>'); ring.appendChild(avatar(c.id));
    var who = el('<div class="who"><div class="un">' + esc(displayName(c)) + (c.verified ? VERIFIED : "") + '</div><div class="loc">' + esc(place(c)) + "</div></div>");
    head.appendChild(ring); head.appendChild(who);
    var more = el('<button aria-label="more">' + svg("dots") + "</button>");
    head.appendChild(more);
    if (!opts.detail) { ring.style.cursor = who.style.cursor = "pointer"; ring.onclick = who.onclick = function () { openPost(c); }; }
    more.onclick = function () { postMenu(c); };
    p.appendChild(head);

    var media = el('<div class="media sk"><img alt="" draggable="false"><div class="bigheart">' + svg("heartF", "") + "</div></div>");
    var img = media.querySelector("img"); img.setAttribute("data-photo", c.id); lazy(img);
    var last = 0;
    media.addEventListener("click", function () {
      var now = Date.now();
      if (now - last < 320) { last = 0; var bh = media.querySelector(".bigheart"); bh.classList.remove("go"); void bh.offsetWidth; bh.classList.add("go"); if (!c.liked) doLike(c, true); else haptic(); }
      else last = now;
    });
    p.appendChild(media);

    var acts = el('<div class="acts"><button class="like' + (c.liked ? " on" : "") + '" aria-label="like">' + svg(c.liked ? "heartF" : "heartO") + '</button><button class="req" aria-label="chat">' + svg("plane") + '</button><span class="sp"></span></div>');
    acts.querySelector(".like").onclick = function () { doLike(c, !c.liked); };
    acts.querySelector(".req").onclick = function () { requestSheet(c); };
    p.appendChild(acts);
    p.appendChild(el('<div class="likes">' + likesText(c) + "</div>"));
    if (c.bio) {
      var cap = el('<div class="cap"><b>' + esc(displayName(c)) + "</b><span class='t'>" + esc(c.bio.length > 90 && !opts.detail ? c.bio.slice(0, 90) + "…" : c.bio) + "</span> " + (c.bio.length > 90 && !opts.detail ? '<span class="more">بیشتر</span>' : "") + "</div>");
      var mo = cap.querySelector(".more");
      if (mo) mo.onclick = function () { cap.querySelector(".t").textContent = c.bio; mo.remove(); };
      p.appendChild(cap);
    }
    return p;
  }
  function syncCard(c) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pid="' + c.id + '"]'), function (p) {
      var b = p.querySelector(".like"); b.classList.toggle("on", c.liked); b.innerHTML = svg(c.liked ? "heartF" : "heartO");
      p.querySelector(".likes").textContent = likesText(c);
    });
  }
  function doLike(c, want) {
    var prev = { liked: c.liked, likes: c.likes };
    c.liked = want; c.likes = Math.max(0, c.likes + (want ? 1 : -1)); syncCard(c); haptic();
    api("like", { id: c.id, like: want }).then(function (r) {
      if (r.ok) { c.liked = r.data.liked; c.likes = r.data.likes; syncCard(c); }
      else { c.liked = prev.liked; c.likes = prev.likes; syncCard(c); toast("لایک ثبت نشد."); }
    }).catch(function () { c.liked = prev.liked; c.likes = prev.likes; syncCard(c); toast("اتصال برقرار نیست."); });
  }
  function postMenu(c) {
    openSheet('<button class="item" id="s1">درخواست چت</button><button class="item" id="s2">' + (c.liked ? "برداشتن لایک" : "لایک") + '</button><button class="item" id="s0">انصراف</button>', function (sh, close) {
      sh.querySelector("#s1").onclick = function () { close(); setTimeout(function () { requestSheet(c); }, 240); };
      sh.querySelector("#s2").onclick = function () { close(); doLike(c, !c.liked); };
      sh.querySelector("#s0").onclick = close;
    });
  }
  function requestSheet(c) {
    openSheet('<div class="shd">درخواست چت</div><div class="ctx">به <b style="color:var(--text)">' + esc(displayName(c)) + '</b> درخواست چت ناشناس فرستاده می‌شود.<br>اگر قبول کند، ۱ رلیک از هر دو نفر کم می‌شود.</div><div class="pad"><button class="btn blue tall" id="go" style="width:100%">ارسال درخواست</button></div><button class="item" id="no" style="margin-top:6px">انصراف</button>', function (sh, close) {
      sh.querySelector("#no").onclick = close;
      var go = sh.querySelector("#go");
      go.onclick = function () {
        go.disabled = true; go.textContent = "…";
        api("request", { id: c.id }).then(function (r) {
          close();
          if (!r.ok) return fail(r);
          var s = r.data.status;
          if (s === "sent") { haptic("ok"); toast("✅ درخواست ارسال شد"); }
          else if (s === "already_pending") toast("قبلاً برای این کاربر درخواست دادی. منتظر جوابش باش.");
          else if (s === "rate_limited") toast("تعداد درخواست‌هات زیاد بوده؛ کمی بعد دوباره امتحان کن.");
          else if (s === "no_balance") toast("موجودی رلیکت کافی نیست (۱ رلیک لازمه).");
          else if (s === "in_chat") toast("الان توی یه چت هستی. اول چت رو تموم کن.");
          else toast("این کاربر دیگه در دسترس نیست.");
        }).catch(function () { close(); toast("خطا در ارسال. دوباره امتحان کن."); });
      };
    });
  }

  /* -------------------------------------------------------- post screen */
  function openPost(c) {
    seenStories[c.id] = true;
    var wrap = el('<div style="display:flex;flex-direction:column;min-height:100%"></div>');
    var top = el('<div class="top"><button aria-label="back">' + svg("back") + '</button><div class="ttl">پست</div><button style="visibility:hidden"></button></div>');
    top.querySelector("button").onclick = popScreen;
    wrap.appendChild(top);
    var body = el('<div class="detail" style="padding-bottom:30px"></div>');
    body.appendChild(postEl(c, { detail: true }));
    var info = el('<div class="info"></div>');
    function kv(icon, k, v) { return v ? '<div class="kv">' + svg(icon) + "<span>" + k + "</span><b style='font-weight:500'>" + esc(v) + "</b></div>" : ""; }
    info.innerHTML = kv("user", "نام", c.name) + kv("cake", "سن", c.age != null ? num(c.age) : "") + kv("pin", "محل", [c.province, c.city].filter(Boolean).join("، "));
    body.appendChild(info);
    var cta = el('<div class="cta"><button class="btn blue tall" id="rq">' + svg("plane") + ' درخواست چت</button><button class="btn tall" id="lk">لایک</button></div>');
    cta.querySelector("svg").style.width = "18px";
    cta.querySelector("#rq").onclick = function () { requestSheet(c); };
    var lk = cta.querySelector("#lk");
    function lkLabel() { lk.textContent = c.liked ? "لایک شد ✓" : "لایک"; }
    lkLabel(); lk.onclick = function () { doLike(c, !c.liked); setTimeout(lkLabel, 30); };
    body.appendChild(cta);
    wrap.appendChild(body);
    pushScreen(wrap);
  }

  /* -------------------------------------------------------------- home */
  function renderHome() {
    var pg = pages.home; pg.innerHTML = "";
    var top = el('<div class="topbar"><div class="icons"><button id="addp" aria-label="add">' + svg("plus") + '</button></div><div class="wordmark">Nava</div><div style="width:24px"></div></div>');
    top.querySelector("#addp").onclick = function () { pickPhoto(); };
    pg.appendChild(top);
    var st = el('<div class="stories" id="stories"></div>'); pg.appendChild(st);
    var list = el('<div id="feedlist"></div>'); pg.appendChild(list);
    pg.appendChild(el('<div class="more-spin hide" id="feedspin"><div class="spin"></div></div>'));
    pg.appendChild(el('<div id="feedend" style="height:2px"></div>'));
    renderStories();
    if (io) { var endIo = new IntersectionObserver(function (en) { if (en[0].isIntersecting) loadFeed(); }, { rootMargin: "600px 0px" }); endIo.observe($("feedend")); }
    pg.addEventListener("scroll", function () { }, { passive: true });
  }
  function renderStories() {
    var st = $("stories"); if (!st) return; st.innerHTML = "";
    var me = el('<button class="story"><div class="ring none"><div class="in"></div><div class="plus">' + '<svg viewBox="0 0 24 24">' + P.plusS + "</svg></div></div><div class=\"nm\">تو</div></button>");
    if (ME && ME.hasPhoto) { var inn = me.querySelector(".in"); inn.setAttribute("data-photo", ME.id); lazy(inn); }
    me.onclick = function () { ME && ME.hasPhoto ? selectTab("profile", true) : pickPhoto(); };
    st.appendChild(me);
    feed.items.slice(0, 14).forEach(function (c) {
      var s = el('<button class="story"><div class="ring ' + (seenStories[c.id] ? "seen" : "") + '"></div><div class="nm">' + esc(displayName(c)) + "</div></button>");
      s.querySelector(".ring").appendChild(avatar(c.id));
      s.onclick = function () { openPost(c); s.querySelector(".ring").classList.add("seen"); };
      st.appendChild(s);
    });
  }
  function emptyHtml(icon, title, text) { return '<div class="empty"><div class="big">' + svg(icon) + "</div><h3>" + title + "</h3>" + text + "</div>"; }
  function loadFeed() {
    if (feed.loading || !feed.more) return; feed.loading = true;
    var spin = $("feedspin"); if (spin) spin.classList.remove("hide");
    api("feed_page", { offset: feed.offset }).then(function (r) {
      feed.loading = false; if (spin) spin.classList.add("hide");
      if (!r.ok) return fail(r);
      var list = $("feedlist");
      remember(r.data.items);
      r.data.items.forEach(function (c) { if (feed.items.some(function (x) { return x.id === c.id; })) return; feed.items.push(c); list.appendChild(postEl(c)); });
      feed.offset += r.data.items.length; feed.more = r.data.hasMore;
      if (!feed.items.length) list.innerHTML = emptyHtml("camera", "هنوز پستی نیست", "به‌محض این‌که کاربرها عکس بذارن اینجا می‌بینی‌شون.");
      renderStories();
    }).catch(function () { feed.loading = false; if (spin) spin.classList.add("hide"); toast("اتصال برقرار نیست."); });
  }
  function skeletonPosts(n) {
    var h = ""; for (var i = 0; i < n; i++) h += '<div class="post"><div class="ph"><div class="ring none"><div class="in sk"></div></div><div class="who"><div class="sk" style="height:10px;width:90px;border-radius:5px"></div></div></div><div class="media sk"></div></div>';
    return h;
  }
  function refreshFeed() {
    feed = { items: [], offset: 0, more: true, loading: false };
    $("feedlist").innerHTML = skeletonPosts(1);
    $("feedlist").innerHTML = ""; loadFeed();
  }
  function nextPost() {
    haptic("sel");
    var pg = pages.home, posts = pg.querySelectorAll(".post"), y = pg.scrollTop, target = null;
    for (var i = 0; i < posts.length; i++) {
      var top = posts[i].offsetTop - 48;
      if (top > y + 24) { target = top; break; }
    }
    if (target == null) { if (feed.more) { loadFeed(); toast("در حال بارگذاری…"); } else toast("به آخر رسیدی ✨"); return; }
    pg.scrollTo({ top: target, behavior: "smooth" });
    if (posts.length - Array.prototype.indexOf.call(posts, posts[i]) < 4) loadFeed();
  }

  /* ----------------------------------------------------------- explore */
  function renderExplore() {
    var pg = pages.explore; pg.innerHTML = "";
    var pill = el('<button class="searchpill">' + svg("searchO") + "<span>جستجو</span></button>");
    pill.onclick = function () { selectTab("search", true); setTimeout(function () { var i = $("pg-search").querySelector("input"); if (i) i.focus(); }, 60); };
    pg.appendChild(pill);
    pg.appendChild(el('<div class="grid" id="grid"></div>'));
    pg.appendChild(el('<div class="more-spin hide" id="exspin"><div class="spin"></div></div>'));
    pg.appendChild(el('<div id="exend" style="height:2px"></div>'));
    if (io) { var e2 = new IntersectionObserver(function (en) { if (en[0].isIntersecting && current === "explore") loadExplore(); }, { rootMargin: "600px 0px" }); e2.observe($("exend")); }
  }
  function tile(c, idx) {
    var t = el('<div class="tile sk' + (idx % 12 === 2 ? " big" : "") + '"><img alt="" draggable="false"></div>');
    var img = t.querySelector("img"); img.setAttribute("data-photo", c.id); lazy(img);
    t.onclick = function () { haptic("sel"); openPost(c); };
    return t;
  }
  function loadExplore() {
    if (expl.loading || !expl.more) return; expl.loading = true;
    var sp = $("exspin"); if (sp) sp.classList.remove("hide");
    api("explore", { offset: expl.offset }).then(function (r) {
      expl.loading = false; if (sp) sp.classList.add("hide");
      if (!r.ok) return fail(r);
      remember(r.data.items);
      var g = $("grid");
      r.data.items.forEach(function (c) { if (expl.items.some(function (x) { return x.id === c.id; })) return; g.appendChild(tile(c, expl.items.length)); expl.items.push(c); });
      expl.offset += r.data.items.length; expl.more = r.data.hasMore;
      if (!expl.items.length) g.outerHTML = emptyHtml("exploreO", "چیزی برای نشون دادن نیست", "هنوز کسی عکس نذاشته.");
    }).catch(function () { expl.loading = false; if (sp) sp.classList.add("hide"); toast("اتصال برقرار نیست."); });
  }
  function refreshExplore() { expl = { items: [], offset: 0, more: true, loading: false }; var g = $("grid"); if (g) g.innerHTML = ""; loadExplore(); }

  /* ------------------------------------------------------------ search */
  var searchTimer, searchSeq = 0;
  function renderSearch() {
    var pg = pages.search; if (pg.firstChild) return;
    var bar = el('<div class="sbar"><div class="field">' + svg("searchO") + '<input type="text" placeholder="جستجوی یوزرنیم" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="25" dir="ltr"><button class="x hide" aria-label="clear"><svg viewBox="0 0 24 24">' + P.close + "</svg></button></div></div>");
    pg.appendChild(bar);
    var res = el('<div id="sres"></div>'); pg.appendChild(res);
    var inp = bar.querySelector("input"), x = bar.querySelector(".x");
    x.onclick = function () { inp.value = ""; inp.focus(); onInput(); };
    inp.addEventListener("input", onInput);
    function onInput() {
      x.classList.toggle("hide", !inp.value);
      clearTimeout(searchTimer);
      var q = inp.value.trim().replace(/^@/, "");
      if (!q) return suggest();
      searchTimer = setTimeout(function () { run(q); }, 260);
    }
    function row(c) {
      var r = el('<div class="row"><div class="ring"></div><div class="t"><b>' + esc(c.username ? c.username : c.name) + (c.verified ? VERIFIED : "") + "</b><span>" + esc(c.username ? c.name : place(c)) + (c.likes ? " • " + num(c.likes) + " لایک" : "") + "</span></div></div>");
      r.querySelector(".ring").appendChild(avatar(c.id));
      r.onclick = function () { haptic("sel"); openPost(c); };
      return r;
    }
    function show(list, title, emptyText) {
      res.innerHTML = "";
      if (title && list.length) res.appendChild(el('<div class="hint">' + title + "</div>"));
      list.forEach(function (c) { res.appendChild(row(c)); });
      if (!list.length) res.innerHTML = emptyHtml("searchO", "نتیجه‌ای پیدا نشد", emptyText);
    }
    function run(q) {
      var my = ++searchSeq;
      res.innerHTML = '<div class="more-spin"><div class="spin"></div></div>';
      api("search", { q: q }).then(function (r) {
        if (my !== searchSeq) return;
        if (!r.ok) return fail(r);
        remember(r.data.items); show(r.data.items, "", "کاربری با این یوزرنیم نیست.");
      }).catch(function () { toast("اتصال برقرار نیست."); });
    }
    function suggest() {
      searchSeq++;
      var go = function (items) { show(items, "پیشنهادی", "هنوز کاربری نیست."); };
      if (expl.items.length) return go(expl.items.slice(0, 12));
      api("explore", { offset: 0 }).then(function (r) { if (r.ok) { remember(r.data.items); if (!inp.value) go(r.data.items.slice(0, 12)); } });
    }
    suggest();
  }

  /* ----------------------------------------------------------- profile */
  function renderProfile() {
    var pg = pages.profile; pg.innerHTML = "";
    if (!ME) return;
    var m = ME;
    var top = el('<div class="ptop"><div class="u">' + esc(m.username || "یوزرنیم انتخاب کن") + (m.username ? svg("chevD") : "") + '</div><div style="display:flex;gap:18px"><button id="pl" aria-label="add">' + svg("plus") + "</button></div></div>");
    top.querySelector("#pl").onclick = function () { pickPhoto(); };
    if (!m.username) top.querySelector(".u").onclick = openEdit;
    pg.appendChild(top);
    var head = el('<div class="phead"><div class="ring ' + (m.hasPhoto ? "" : "none") + '"></div><div class="stats"><div><b>' + num(m.likes) + "</b><span>لایک</span></div><div><b>" + num(m.relic) + "</b><span>رلیک</span></div><div><b style='font-size:13px;line-height:22px'>" + esc(m.level) + "</b><span>سطح</span></div></div></div>");
    var ring = head.querySelector(".ring"); var inn = avatar(m.hasPhoto ? m.id : null); ring.appendChild(inn);
    ring.style.cursor = "pointer"; ring.onclick = pickPhoto;
    pg.appendChild(head);
    pg.appendChild(el('<div class="pbio"><div class="n">' + esc(m.name) + (m.verified ? VERIFIED : "") + "</div>" + (m.bio ? '<div class="d">' + esc(m.bio) + "</div>" : '<div class="s">بیوگرافی نداری — از «ویرایش پروفایل» اضافه کن.</div>') + "</div>"));
    var btns = el('<div class="pbtns"><button class="btn" id="ed">ویرایش پروفایل</button><button class="btn" id="ch">تغییر عکس</button></div>');
    btns.querySelector("#ed").onclick = openEdit; btns.querySelector("#ch").onclick = pickPhoto;
    pg.appendChild(btns);
    pg.appendChild(el('<div class="ptabs"><div>' + svg("grid") + "</div></div>"));
    if (m.hasPhoto) {
      var g = el('<div class="grid"></div>'); var t = el('<div class="tile sk"><img alt="" draggable="false">' + (m.photoPending ? '<div class="pend">در انتظار تایید ادمین</div>' : "") + "</div>");
      var im = t.querySelector("img"); im.setAttribute("data-photo", m.id); lazy(im);
      g.appendChild(t); pg.appendChild(g);
    } else pg.appendChild(el(emptyHtml("camera", m.photoPending ? "عکس در انتظار تاییده" : "اولین عکستو بذار", m.photoPending ? "بعد از تایید ادمین نمایش داده می‌شه." : "عکس پروفایل بذار تا بقیه ببینن‌ت.") ));
    if (!m.hasPhoto && !m.photoPending) { var b = el('<div style="padding:0 40px"><button class="btn blue tall" style="width:100%">انتخاب عکس</button></div>'); b.querySelector("button").onclick = pickPhoto; pg.appendChild(b); }
    var tav = $("tabav"); if (tav && m.hasPhoto) { tav.setAttribute("data-photo", m.id); lazy(tav); }
  }
  function refreshMe() {
    return api("me").then(function (r) { if (r.ok) { ME = r.data.me; if (current === "profile") renderProfile(); renderStories(); var tav = $("tabav"); if (tav && ME.hasPhoto) { tav.style.backgroundImage = ""; tav.setAttribute("data-photo", ME.id); fill(tav); } } });
  }

  /* -------------------------------------------------------------- edit */
  var USER_ERR = { taken: "این یوزرنیم قبلاً انتخاب شده", too_short: "حداقل ۳ کاراکتر", too_long: "حداکثر ۲۴ کاراکتر", bad_chars: "فقط حروف انگلیسی، عدد، _ و . مجازه", bad_dots: "نقطه نباید اول/آخر یا پشت‌سرهم باشه", reserved: "این یوزرنیم رزرو شده" };
  function openEdit() {
    var m = ME, orig = { u: m.username || "", b: m.bio || "" };
    var w = el('<div style="min-height:100%;display:flex;flex-direction:column"></div>');
    var top = el('<div class="top"><button id="cn">انصراف</button><div class="ttl">ویرایش پروفایل</div><button class="done" id="dn">تایید</button></div>');
    w.appendChild(top);
    var av = el('<div class="editav"><div class="ring"></div><button class="chg">تغییر عکس پروفایل</button></div>');
    var ring = av.querySelector(".ring"); ring.appendChild(avatar(m.hasPhoto ? m.id : null)); ring.firstChild.style.borderRadius = "50%";
    av.querySelector(".chg").onclick = pickPhoto; ring.onclick = pickPhoto;
    w.appendChild(av);
    var f1 = el('<div class="field-row"><label>نام</label><div class="v"><span class="ro">' + esc(m.name) + '</span><div class="msg" style="color:var(--muted)">نام رو از داخل ربات می‌تونی عوض کنی.</div></div></div>');
    var f2 = el('<div class="field-row"><label>یوزرنیم</label><div class="v"><input class="ltr" dir="ltr" maxlength="25" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="@username" value="' + esc(orig.u ? "@" + orig.u : "") + '"><div class="line"></div><div class="msg"></div></div></div>');
    var f3 = el('<div class="field-row"><label>بیوگرافی</label><div class="v"><textarea rows="3" maxlength="150" placeholder="بیوگرافی">' + esc(orig.b) + '</textarea><div class="line"></div><div class="cnt"></div></div></div>');
    w.appendChild(f1); w.appendChild(f2); w.appendChild(f3);
    w.appendChild(el('<div class="note">یوزرنیم مینی‌اپ فقط برای همین بخشه و جدا از یوزرنیم تلگرامته. هر تغییری اینجا، توی پروفایل ربات هم نشون داده می‌شه.</div>'));
    var ui = f2.querySelector("input"), um = f2.querySelector(".msg"), bi = f3.querySelector("textarea"), bc = f3.querySelector(".cnt"), dn = top.querySelector("#dn");
    var okName = true, seq = 0, t;
    function cnt() { bc.textContent = bi.value.length + " / 150"; }
    cnt(); bi.addEventListener("input", function () { cnt(); changed(); });
    function changed() { dn.disabled = !(okName && (clean() !== orig.u || bi.value.trim() !== orig.b)); }
    function clean() { return ui.value.trim().replace(/^@/, ""); }
    function setMsg(txt, kind) { um.textContent = txt; um.className = "msg " + (kind || ""); }
    ui.addEventListener("input", function () {
      var v = clean(); clearTimeout(t); okName = true; changed();
      if (!v || v === orig.u) { setMsg(""); changed(); return; }
      okName = false; changed(); setMsg("در حال بررسی…");
      var my = ++seq;
      t = setTimeout(function () {
        api("check_username", { username: v }).then(function (r) {
          if (my !== seq) return;
          if (!r.ok) return setMsg("خطا در بررسی", "err");
          if (r.data.available) { okName = true; setMsg("✓ " + v + " آزاده", "ok"); } else setMsg(USER_ERR[r.data.reason] || "نامعتبر", "err");
          changed();
        });
      }, 350);
    });
    dn.disabled = true;
    top.querySelector("#cn").onclick = popScreen;
    dn.onclick = function () {
      dn.disabled = true;
      var chain = Promise.resolve(true);
      var nu = clean();
      if (nu !== orig.u && nu) chain = chain.then(function () { return api("set_username", { username: nu }).then(function (r) { if (!r.ok) { setMsg(USER_ERR[r.data.error] || "ذخیره نشد", "err"); haptic("err"); return false; } return true; }); });
      chain = chain.then(function (ok) { if (!ok) return false; if (bi.value.trim() === orig.b) return true; return api("set_bio", { bio: bi.value }).then(function (r) { if (!r.ok) { toast("بیوگرافی ذخیره نشد."); return false; } return true; }); });
      chain.then(function (ok) { if (!ok) { dn.disabled = false; return; } haptic("ok"); toast("پروفایل ذخیره شد ✓"); refreshMe().then(function () { popScreen(); }); });
    };
    pushScreen(w);
  }

  /* ------------------------------------------------------- photo upload */
  function pickPhoto() {
    var inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = function () { var f = inp.files && inp.files[0]; if (f) openCrop(f); };
    inp.click();
  }
  function loadBitmap(file) {
    if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return viaImg(file); });
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise(function (res, rej) { var u = URL.createObjectURL(file), i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = u; });
  }
  function openCrop(file) {
    loadBitmap(file).then(function (bmp) {
      var iw = bmp.width || bmp.naturalWidth, ih = bmp.height || bmp.naturalHeight;
      var W = 1080, H = 1350;
      var w = el('<div style="min-height:100%;display:flex;flex-direction:column;background:#000;color:#fff"></div>');
      var top = el('<div class="top" style="background:#000;color:#fff;border-color:#262626"><button id="cn">انصراف</button><div class="ttl">عکس جدید</div><button class="done" id="dn">اشتراک</button></div>');
      var wrap = el('<div class="cropwrap"><div class="crop"><canvas width="540" height="675"></canvas></div></div>');
      var zoom = el('<div class="zoom"><span>−</span><input type="range" min="1" max="3" step="0.01" value="1"><span>+</span></div>');
      w.appendChild(top); w.appendChild(wrap); w.appendChild(zoom);
      var cv = wrap.querySelector("canvas"), ctx = cv.getContext("2d"), box = wrap.querySelector(".crop");
      var base = Math.max(W / iw, H / ih), z = 1, ox = 0, oy = 0;
      function clamp() { var sw = iw * base * z, sh = ih * base * z; ox = Math.min(0, Math.max(W - sw, ox)); oy = Math.min(0, Math.max(H - sh, oy)); }
      function draw(c, cw, ch) { var k = cw / W; c.fillStyle = "#000"; c.fillRect(0, 0, cw, ch); c.drawImage(bmp, ox * k, oy * k, iw * base * z * k, ih * base * z * k); }
      function center() { ox = (W - iw * base * z) / 2; oy = (H - ih * base * z) / 2; }
      center(); clamp(); draw(ctx, 540, 675);
      var drag = null;
      box.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY, ox: ox, oy: oy }; box.setPointerCapture(e.pointerId); box.style.cursor = "grabbing"; });
      box.addEventListener("pointermove", function (e) { if (!drag) return; var r = box.getBoundingClientRect(), k = W / r.width; ox = drag.ox + (e.clientX - drag.x) * k; oy = drag.oy + (e.clientY - drag.y) * k; clamp(); draw(ctx, 540, 675); });
      box.addEventListener("pointerup", function () { drag = null; box.style.cursor = "grab"; });
      zoom.querySelector("input").addEventListener("input", function (e) {
        var nz = parseFloat(e.target.value), cx = (W / 2 - ox) / (iw * base * z), cy = (H / 2 - oy) / (ih * base * z);
        z = nz; ox = W / 2 - cx * iw * base * z; oy = H / 2 - cy * ih * base * z; clamp(); draw(ctx, 540, 675);
      });
      top.querySelector("#cn").onclick = popScreen;
      var dn = top.querySelector("#dn");
      dn.onclick = function () {
        dn.disabled = true; dn.textContent = "…";
        var out = document.createElement("canvas"); out.width = W; out.height = H; draw(out.getContext("2d"), W, H);
        var data = out.toDataURL("image/jpeg", 0.86);
        api("upload_photo", { image: data }).then(function (r) {
          if (r.ok) {
            haptic("ok"); ver++; popScreen();
            toast(r.data.status === "approved" ? "✅ عکس شما ثبت شد" : "عکس برای بررسی به ادمین ارسال شد");
            refreshMe().then(function () { if (r.data.status === "approved") { feed = { items: [], offset: 0, more: true, loading: false }; renderHome(); loadFeed(); } });
          } else {
            dn.disabled = false; dn.textContent = "اشتراک"; haptic("err");
            var e = r.data && r.data.error;
            toast(e === "too_fast" ? "کمی صبر کن و دوباره امتحان کن." : e === "bad_image" ? "این عکس قابل استفاده نیست." : e === "unavailable" ? "فعلاً امکان آپلود نیست." : "آپلود انجام نشد.");
          }
        }).catch(function () { dn.disabled = false; dn.textContent = "اشتراک"; toast("اتصال برقرار نیست."); });
      };
      pushScreen(w);
    }).catch(function () { toast("این فایل عکس نیست."); });
  }

  /* -------------------------------------------------------------- boot */
  function boot() {
    if (!initData) { return fatal("مینی‌اپ رو از داخل تلگرام باز کن", "دکمه‌ی مینی‌اپ داخل ربات رو بزن."); }
    api("whoami").then(function (r) {
      if (!r.ok) return fail(r);
      if (r.data.role === "staff") { location.replace("/monitor/"); return; }
      ME = r.data.me;
      buildShell(); renderHome(); renderExplore();
      pages.home.classList.add("on"); movePill();
      if (ME.hasPhoto) { var tav = $("tabav"); tav.setAttribute("data-photo", ME.id); lazy(tav); }
      loadFeed(); hideSplash();
    }).catch(function () { fatal("اتصال برقرار نیست", "اینترنتت رو چک کن و دوباره باز کن."); });
  }
  boot();
})();
