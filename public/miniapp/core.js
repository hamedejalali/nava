/* نوا گرام — core: Telegram bootstrap, helpers, icons, API, layers (screens / sheets). Vanilla JS, no build step. */
(function () {
  "use strict";
  var NG = (window.NG = {});
  var tg = (NG.tg = window.Telegram && window.Telegram.WebApp);
  NG.initData = (tg && tg.initData) || "";
  var qs = (NG.qs = new URLSearchParams(location.search));
  NG.col = document.getElementById("col");
  NG.me = null;
  NG.bot = null;

  /* ------------------------------------------------------------ theme */
  var light = false;
  try { light = !!tg && tg.colorScheme === "light"; } catch (e) {}
  if (qs.get("theme")) light = qs.get("theme") === "light";
  if (light) document.documentElement.setAttribute("data-theme", "light");
  if (tg) {
    try {
      tg.ready(); tg.expand();
      var c = light ? "#ffffff" : "#000000";
      tg.setHeaderColor(c); tg.setBackgroundColor(c);
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (e) {}
  }

  /* ---------------------------------------------------------- helpers */
  var $ = (NG.$ = function (id) { return document.getElementById(id); });
  NG.esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]; }); };
  NG.num = function (n) { try { return Number(n).toLocaleString("fa-IR"); } catch (e) { return String(n); } };
  NG.el = function (html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; };
  NG.haptic = function (k) {
    try {
      var h = tg.HapticFeedback;
      if (k === "sel") h.selectionChanged(); else if (k === "ok") h.notificationOccurred("success"); else if (k === "err") h.notificationOccurred("error"); else h.impactOccurred("light");
    } catch (e) {}
  };
  var toastT;
  NG.toast = function (t) {
    var e = $("toast"); e.textContent = t; e.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { e.classList.remove("show"); }, 2800);
  };
  NG.ago = function (ms) {
    var s = Math.max(0, (Date.now() + (NG.skew || 0) - ms) / 1000); // NG.skew: server clock − this phone's clock
    if (s < 45) return "همین الان";
    if (s < 3600) return NG.num(Math.max(1, Math.round(s / 60))) + " دقیقه پیش";
    if (s < 86400) return NG.num(Math.round(s / 3600)) + " ساعت پیش";
    if (s < 7 * 86400) return NG.num(Math.round(s / 86400)) + " روز پیش";
    try { return new Date(ms).toLocaleDateString("fa-IR", { month: "long", day: "numeric" }); } catch (e) { return ""; }
  };
  NG.ls = {
    get: function (k, d) { try { var v = localStorage.getItem("ng." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("ng." + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem("ng." + k); } catch (e) {} }
  };

  /* ------------------------------------------------------------ events */
  var handlers = {};
  NG.on = function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); };
  NG.emit = function (ev, data) { (handlers[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { console.error(e); } }); };

  /* ------------------------------------------------------------- icons */
  var S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  var P = (NG.P = {
    homeO: '<path d="M9.005 16.545a2.997 2.997 0 0 1 2.997-2.997A2.997 2.997 0 0 1 15 16.545V22h7V11.543L12 2 2 11.543V22h7.005Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    homeF: '<path d="M22 23h-6.001a1 1 0 0 1-1-1v-5.455a2.997 2.997 0 1 0-5.993 0V22a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V11.543a1.002 1.002 0 0 1 .31-.724l10-9.543a1.001 1.001 0 0 1 1.38 0l10 9.543a1.002 1.002 0 0 1 .31.724V22a1 1 0 0 1-1 1Z" fill="currentColor"/>',
    matchO: '<rect x="4" y="3" width="16" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 16.2s-3.6-2.2-3.6-4.8a2 2 0 0 1 3.6-1.2 2 2 0 0 1 3.6 1.2c0 2.6-3.6 4.8-3.6 4.8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    matchF: '<rect x="4" y="3" width="16" height="18" rx="4" fill="currentColor"/><path d="M12 16.2s-3.6-2.2-3.6-4.8a2 2 0 0 1 3.6-1.2 2 2 0 0 1 3.6 1.2c0 2.6-3.6 4.8-3.6 4.8Z" fill="var(--bg)"/>',
    exploreO: '<polygon fill="none" points="13.941 13.953 7.581 16.424 10.06 10.056 16.42 7.585 13.941 13.953" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/><polygon fill="currentColor" fill-rule="evenodd" points="10.06 10.056 13.941 13.953 7.581 16.424 10.06 10.056"/><circle cx="12.001" cy="12.005" fill="none" r="10.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>',
    exploreF: '<path d="M12 .5C5.649.5.5 5.649.5 12S5.649 23.5 12 23.5 23.5 18.351 23.5 12 18.351.5 12 .5Zm4.42 7.085a.5.5 0 0 1 .64.64l-2.6 6.66a.5.5 0 0 1-.29.29l-6.66 2.6a.5.5 0 0 1-.64-.64l2.6-6.66a.5.5 0 0 1 .29-.29Z" fill="currentColor" fill-rule="evenodd"/><path d="M10.06 10.056l3.881 3.897-6.36 2.471Z" fill="currentColor"/>',
    searchO: '<path d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="16.511" x2="22" y1="16.511" y2="22"/>',
    searchF: '<path d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" x1="16.511" x2="22" y1="16.511" y2="22"/>',
    heartO: '<path d="M16.792 3.904A4.989 4.989 0 0 1 21.5 9.122c0 3.072-2.652 4.959-5.197 7.222-2.512 2.243-3.865 3.469-4.303 3.752-.477-.309-2.143-1.823-4.303-3.752C5.141 14.072 2.5 12.167 2.5 9.122a4.989 4.989 0 0 1 4.708-5.218 4.21 4.21 0 0 1 3.675 1.941c.84 1.175.98 1.763 1.12 1.763s.278-.588 1.11-1.766a4.17 4.17 0 0 1 3.679-1.938m0-2a6.04 6.04 0 0 0-4.797 2.127 6.052 6.052 0 0 0-4.787-2.127A6.985 6.985 0 0 0 .5 9.122c0 3.61 2.55 5.827 5.015 7.97.283.246.569.494.853.747l1.027.918a44.998 44.998 0 0 0 3.518 3.018 2 2 0 0 0 2.174 0 45.263 45.263 0 0 0 3.626-3.115l.922-.824c.293-.26.59-.519.885-.774 2.334-2.025 4.98-4.32 4.98-7.94a6.985 6.985 0 0 0-6.708-7.218Z" fill="currentColor"/>',
    heartF: '<path d="M17.075 1.987a5.852 5.852 0 0 0-5.07 2.66l-.008.01-.002-.01a5.854 5.854 0 0 0-5.07-2.66A6.959 6.959 0 0 0 .5 9.122c0 3.61 2.55 5.827 5.015 7.97.283.246.569.494.853.747l1.027.918a44.998 44.998 0 0 0 3.518 3.018 2 2 0 0 0 2.174 0 45.263 45.263 0 0 0 3.626-3.115l.922-.824c.293-.26.59-.519.885-.774 2.334-2.025 4.98-4.32 4.98-7.94a6.959 6.959 0 0 0-6.425-7.135Z" fill="currentColor"/>',
    comment: '<path d="M20.656 17.008a9.993 9.993 0 1 0-3.59 3.615L22 22Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    plane: '<line fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" x1="22" x2="9.218" y1="3" y2="10.083"/><polygon fill="none" points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    dots: '<circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
    plus: '<path d="M2 12v3.45c0 2.849.698 4.005 1.606 4.944.94.909 2.098 1.608 4.946 1.608h6.896c2.848 0 4.006-.7 4.946-1.608C21.302 19.455 22 18.3 22 15.45V8.552c0-2.849-.698-4.006-1.606-4.945C19.454 2.7 18.296 2 15.448 2H8.552c-2.848 0-4.006.699-4.946 1.607C2.698 4.547 2 5.703 2 8.552Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="6.545" x2="17.455" y1="12.001" y2="12.001"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="12.003" x2="12.003" y1="6.545" y2="17.455"/>',
    plusS: '<path d="M12 5v14M5 12h14" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3"/>',
    menu: '<line x1="3" x2="21" y1="5" y2="5" ' + S + ' stroke-width="2"/><line x1="3" x2="21" y1="12" y2="12" ' + S + ' stroke-width="2"/><line x1="3" x2="21" y1="19" y2="19" ' + S + ' stroke-width="2"/>',
    back: '<path d="M9 4l8 8-8 8" ' + S + ' stroke-width="2.4"/>',
    chevD: '<path d="m6 9 6 6 6-6" ' + S + ' stroke-width="2.6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" ' + S + ' stroke-width="2.6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7" ' + S + ' stroke-width="2.6"/>',
    grid: '<rect fill="none" height="18" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" width="18" x="3" y="3"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="9.015" x2="9.015" y1="3" y2="21"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="14.985" x2="14.985" y1="3" y2="21"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="9.015" y2="9.015"/><line fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="21" x2="3" y1="14.985" y2="14.985"/>',
    gift: '<rect x="3" y="8" width="18" height="4.5" rx="1.2" ' + S + ' stroke-width="2"/><path d="M5 12.5V21h14v-8.5M12 8v13M12 8C9.5 3.5 5.5 4.5 7 7.4 7.6 8.2 9.6 8 12 8Zm0 0c2.5-4.5 6.5-3.5 5-.6-.6.8-2.6.6-5 .6Z" ' + S + ' stroke-width="2"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" ' + S + ' stroke-width="2"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" ' + S + ' stroke-width="2"/><circle cx="12" cy="12" r="3" ' + S + ' stroke-width="2"/>',
    camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l1.3-2h8l1.3 2h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.9"/><circle cx="12" cy="13" r="3.7" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    user: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c.6-4.2 3.8-6.5 8-6.5s7.4 2.3 8 6.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>',
    pin: '<path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    cake: '<path d="M4 21V12h16v9M2 21h20M12 12V8M12 8c-1.2-1-1.2-2.4 0-3.6 1.2 1.2 1.2 2.6 0 3.6Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>',
    archive: '<rect x="3" y="4" width="18" height="4.5" rx="1" ' + S + ' stroke-width="2"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 13h4" ' + S + ' stroke-width="2"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" ' + S + ' stroke-width="2"/>',
    star: '<path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8Z" ' + S + ' stroke-width="1.8"/>',
    dmO: '<line fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" x1="22" x2="9.218" y1="3" y2="10.083"/><polygon fill="none" points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/>',
    dmF: '<polygon points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/><line fill="none" stroke="var(--bg)" stroke-linejoin="round" stroke-width="2" x1="22" x2="9.218" y1="3" y2="10.083"/>',
    chat: '<path d="M4 5.5h16v10.5H9.5L5.5 20v-4H4Z" ' + S + ' stroke-width="2"/>'
  });
  NG.VERIFIED = '<svg class="verified" viewBox="0 0 40 40"><path d="M19.998 3.094 14.638 0l-2.972 5.15H5.432v6.354L0 14.64 3.094 20 0 25.359l5.432 3.137v5.905h5.975L14.638 40l5.36-3.094L25.358 40l3.232-5.6h6.162v-6.01L40 25.359 36.905 20 40 14.641l-5.248-3.03v-6.46h-6.419L25.358 0l-5.36 3.094Z" fill="#0095f6"/><path d="M28.452 14.97 17.4 26.02l-5.47-5.47" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  NG.svg = function (name, cls) { return '<svg class="' + (cls == null ? "ico" : cls) + '" viewBox="0 0 24 24" aria-hidden="true">' + P[name] + "</svg>"; };

  /* --------------------------------------------------------------- api */
  NG.api = function (action, body) {
    body = body || {}; body.action = action; body.initData = NG.initData;
    if (qs.get("as") === "user") body.asUser = true;
    if (NG.actAs) body.actAs = NG.actAs; // owner / admins working AS a default member (verified on the server)
    return fetch("/api/miniapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        try { var dh = r.headers.get("Date"); if (dh) { var sv = Date.parse(dh); if (sv) NG.skew = sv - Date.now(); } } catch (e) {}
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
      });
  };
  /** Like NG.api but reports upload progress (0..1) — used for photo uploads. */
  NG.apiUp = function (action, body, onProgress) {
    body = body || {}; body.action = action; body.initData = NG.initData;
    if (qs.get("as") === "user") body.asUser = true;
    if (NG.actAs) body.actAs = NG.actAs;
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(); x.open("POST", "/api/miniapp");
      x.setRequestHeader("Content-Type", "application/json");
      if (x.upload && onProgress) x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = function () { var d = {}; try { d = JSON.parse(x.responseText); } catch (e) {} if (onProgress) onProgress(1); resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, data: d }); };
      x.onerror = x.ontimeout = function () { reject(new Error("net")); };
      x.send(JSON.stringify(body));
    });
  };
  var ERR = {
    insufficient: "ژتون کافی نیست", need_photo: "برای این بخش اول باید عکس پروفایلت تأیید شده باشه.", not_registered: "ابتدا از داخل ربات ثبت‌نام کنید", too_fast: "کمی صبر کن و دوباره امتحان کن.", too_many: "به سقف مجاز امروز رسیدی.",
    bad_image: "این عکس قابل استفاده نیست.", text_too_long: "متن خیلی طولانیه.", bad_text: "متن معتبر نیست.", bad_input: "ورودی نامعتبره.",
    chat_running: "اول چت رو پایان بده.", read_only: "این گفتگو فقط‌خواندنیه.", insufficient: "ژتون کافی نیست",
    forbidden: "اجازه‌ی این کار رو نداری.", comments_off: "کامنت‌ها برای این پست بسته شده.", not_found: "پیدا نشد (ممکنه حذف شده باشه).",
    share_unavailable: "الان اشتراک‌گذاری ممکن نیست.", unavailable: "فعلاً امکانش نیست.", self: "این کار روی خودت ممکن نیست.",
    bad_gift: "این هدیه در دسترس نیست.", bad_name: "نام باید فارسی باشه (حداکثر ۳۲ حرف).", bad_age: "سن باید عددی بین ۹ تا ۹۹ باشه.",
    same_value: "این مقدار همونیه که الان داری.", pending_request: "یه درخواست در حال بررسی داری.", bio_too_long: "بیوگرافی حداکثر ۳۰۰ کاراکتر.",
    taken: "این یوزرنیم قبلاً انتخاب شده", chat_ended: "این چت تموم شده.", contact_forbidden: "فرستادن آیدی/شماره/لینک تلگرام مجاز نیست.", busy: "الان توی یه بازی/چت دیگه‌ای هستی.", game_limit: "حداکثر ۵ بازی هم‌زمان می‌تونی داشته باشی.", same_opponent: "با این بازیکن همین الان یه بازی در جریان داری.", not_your_turn: "نوبت تو نیست.", illegal_move: "این حرکت مجاز نیست.",  sold_out: "این هدیه‌ی یکتا همین الان به شخص دیگه‌ای فروخته شد."
  };
  /** The account the owner is working as (a default member's Nava ID), remembered for this session only. */
  NG.actAs = null;
  try { NG.actAs = sessionStorage.getItem("ng_actas") || null; } catch (e) {}
  NG.setActAs = function (anonId) {
    NG.actAs = anonId || null;
    try { if (anonId) sessionStorage.setItem("ng_actas", anonId); else sessionStorage.removeItem("ng_actas"); } catch (e) {}
  };
  NG.errText = function (r, fallback) { var e = r && r.data && r.data.error; return ERR[e] || fallback || "انجام نشد. دوباره امتحان کن."; };
  /** Full-screen message. `action` = { label, url } adds a button that opens a link (e.g. the support chat). */
  NG.fatal = function (title, text, action) {
    NG.col.innerHTML = '<div class="fatal"><h3>' + NG.esc(title) + "</h3>" + NG.esc(text) + (action && action.url ? '<div><a class="btn blue tall fatalbtn" href="#" id="fatalgo">' + NG.esc(action.label) + "</a></div>" : "") + "</div>";
    var go = NG.col.querySelector("#fatalgo");
    if (go) go.onclick = function (e) {
      e.preventDefault();
      try { if (window.Telegram && Telegram.WebApp && /^https:\/\/t\.me\//i.test(action.url)) return Telegram.WebApp.openTelegramLink(action.url); } catch (x) {}
      window.open(action.url, "_blank");
    };
    NG.hideSplash();
  };
  /** force-join: lists the channels still missing (with join buttons) and a re-check that does not need the app to be reopened */
  NG.joinScreen = function (channels) {
    var h = '<div class="fatal"><h3>عضویت در کانال‌ها لازمه</h3>' + NG.esc("اول داخل این کانال‌ها عضو شو، بعد دکمه‌ی «بررسی دوباره» رو بزن.") + "<div>";
    (channels || []).forEach(function (c, i) { h += '<a class="btn blue tall fatalbtn jn" href="#" data-i="' + i + '" style="display:block;margin:8px 0">' + NG.esc(c.title || "کانال") + "</a>"; });
    h += '<a class="btn tall fatalbtn" href="#" id="jnre" style="display:block;margin:8px 0">✅ بررسی دوباره</a></div></div>';
    NG.col.innerHTML = h;
    NG.col.querySelectorAll(".jn").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var url = (channels[Number(a.getAttribute("data-i"))] || {}).url;
        if (!url) return;
        try { if (window.Telegram && Telegram.WebApp && /^https:\/\/t\.me\//i.test(url)) return Telegram.WebApp.openTelegramLink(url); } catch (x) {}
        window.open(url, "_blank");
      };
    });
    NG.col.querySelector("#jnre").onclick = function (e) { e.preventDefault(); location.reload(); };
    NG.hideSplash();
  };
  NG.fail = function (r) {
    var e = r && r.data && r.data.error;
    if (e === "join_required") return NG.joinScreen((r.data && r.data.channels) || []);
    if (e === "not_registered" && NG.guest) return NG.toast("ابتدا ثبت‌نام کنید");
    if (e === "not_registered") return NG.fatal("ثبت‌نام کامل نیست", "اول ثبت‌نام رو داخل ربات کامل کن (/start).");
    if (e === "maintenance") return NG.fatal("🛠 نوا در حال به‌روزرسانی است", (r.data && r.data.text) || "به‌زودی برمی‌گردیم.");
    if (e === "banned") return NG.fatal("شما مسدود شدید", "برای رفع مسدودیت به پشتیبانی پیام بدین.", r.data.support ? { label: "📩 پیام به پشتیبانی", url: r.data.support } : null);
    if (r && r.status === 401) return NG.fatal("مینی‌اپ رو از داخل تلگرام باز کن", "دکمه‌ی مینی‌اپ داخل ربات رو بزن.");
    NG.toast(NG.errText(r));
  };
  /* ------------------------------------------------ animated (Telegram) gifts */
  var lottieP = null;
  NG.loadLottie = function () {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (!lottieP) lottieP = new Promise(function (ok, no) {
      var sc = document.createElement("script"); sc.src = "vendor/lottie_light.min.js?v=1.26.0";
      sc.onload = function () { ok(window.lottie); }; sc.onerror = function () { lottieP = null; no(new Error("lottie")); };
      document.head.appendChild(sc);
    });
    return lottieP;
  };
  var io = null;
  function visObserver() {
    if (io || !("IntersectionObserver" in window)) return io;
    io = new IntersectionObserver(function (es) { es.forEach(function (e) { var f = e.target.__anim; if (f) f(e.isIntersecting); }); }, { rootMargin: "80px" });
    return io;
  }
  /** Puts a Telegram animation (TGS/Lottie, WebM video or still WebP) into `box`; plays only while visible. Falls back silently to the emoji. */
  NG.mountAnim = function (box, anim) {
    if (!anim || !anim.url) return;
    var fmt = anim.format;
    if (fmt === "webm") {
      var v = document.createElement("video"); v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "metadata"; v.src = anim.url; v.className = "ganim";
      v.oncanplay = function () { box.classList.add("hasanim"); };
      box.appendChild(v);
      box.__anim = function (on) { try { if (on) v.play().catch(function () {}); else v.pause(); } catch (e) {} };
    } else if (fmt === "webp" || fmt === "png" || fmt === "jpg") {
      var im = document.createElement("img"); im.className = "ganim gmove"; im.alt = ""; im.onload = function () { box.classList.add("hasanim"); }; im.src = anim.url; box.appendChild(im);
    } else {
      NG.loadLottie().then(function (lt) {
        var holder = document.createElement("div"); holder.className = "ganim"; box.appendChild(holder);
        var a = lt.loadAnimation({ container: holder, renderer: "svg", loop: true, autoplay: false, path: anim.url, rendererSettings: { progressiveLoad: true } });
        a.addEventListener("DOMLoaded", function () { box.classList.add("hasanim"); a.play(); });
        a.addEventListener("data_failed", function () { holder.remove(); });
        box.__anim = function (on) { try { if (on) a.play(); else a.pause(); } catch (e) {} };
      }).catch(function () {});
    }
    var o = visObserver(); if (o) o.observe(box); else if (box.__anim) box.__anim(true);
  };
  /* where the finger last touched: stories open "from" there, like Instagram */
  NG.lastTap = null;
  document.addEventListener("pointerdown", function (e) { NG.lastTap = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);

  NG.netErr = function () { NG.toast("اتصال برقرار نیست."); };
  /** splash progress bar (0..100) — only ever moves forward */
  var splashPct = 6;
  NG.splashProgress = function (p) {
    var b = $("splashbar"); if (!b || p <= splashPct) return;
    splashPct = Math.min(100, p); b.style.width = splashPct + "%";
  };
  // optional artwork (assets/logo.png, assets/splash-bg.jpg): used only if the file really exists
  (function () {
    function probe(url, ok) { var i = new Image(); i.onload = function () { ok(url); }; i.src = url; }
    probe("assets/splash-bg.jpg?v=1", function (u) { var s = $("splash"); if (s) { s.style.setProperty("--splash-bg", "url('" + u + "')"); s.classList.add("has-bg"); } });
    probe("assets/logo.png?v=1", function (u) {
      var w = document.querySelector("#splash .logo-wrap"); if (!w) return;
      var img = document.createElement("img"); img.className = "logo-img"; img.alt = ""; img.src = u;
      var svgEl = w.querySelector(".logo"); if (svgEl) svgEl.replaceWith(img);
    });
  })();
  NG.hideSplash = function () {
    var s = $("splash"); if (!s) return;
    NG.splashProgress(100);
    s.classList.add("gone"); setTimeout(function () { if (s.parentNode) s.remove(); }, 520);
  };

  /* ------------------------------------------------------------- images */
  NG.img = function (src, cls) {
    var i = document.createElement("img");
    i.className = "fadeimg " + (cls || ""); i.alt = ""; i.draggable = false; i.decoding = "async";
    i.onload = function () { i.classList.add("on"); var p = i.parentNode; if (p) p.classList.remove("sk"); };
    i.onerror = function () { var p = i.parentNode; if (p) p.classList.remove("sk"); i.remove(); };
    if (src) i.src = src;
    return i;
  };
  /* avatar ring: brief = {av, story, name}; story 2 = unseen (colour ring), 1 = seen (grey), 0 = none */
  NG.ring = function (b, opts) {
    opts = opts || {};
    var st = opts.noStory ? 0 : (b && b.story) || 0;
    var r = NG.el('<div class="ring ' + (st === 2 ? "" : st === 1 ? "seen" : "none") + '"><div class="in"></div></div>');
    var inn = r.firstChild;
    if (b && b.id) r.setAttribute("data-uid", b.id);
    if (b && b.av) { inn.classList.add("sk"); inn.appendChild(NG.img(b.av)); }
    else inn.innerHTML = NG.svg("user", "");
    return r;
  };
  NG.setRing = function (ring, st) { ring.classList.toggle("seen", st === 1); ring.classList.toggle("none", !st); };
  /** Updates every ring of one user on screen (tray, post headers, profile) after a story was watched / posted. */
  NG.setUserStory = function (uid, st) {
    Array.prototype.forEach.call(document.querySelectorAll('.ring[data-uid="' + uid + '"]'), function (r) { if (!r.hasAttribute("data-fixed")) NG.setRing(r, st); });
  };
  /** blue tick (+ the official account's gold coin) shown after a name */
  NG.vb = function (u) { return u && u.verified ? NG.VERIFIED + (u.gold ? '<span class="goldc" title="Nava">🪙</span>' : "") : ""; };
  NG.nameOf = function (b) { return b.username || b.name; };

  /* ------------------------------------------------- layers / back button */
  var layers = [], screens = 0;
  function syncBack() {
    if (!tg || !tg.BackButton) return;
    try { if (layers.length) tg.BackButton.show(); else tg.BackButton.hide(); } catch (e) {}
  }
  NG.addLayer = function (close) {
    var l = { close: close }; layers.push(l); syncBack();
    return function () { var i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); syncBack(); };
  };
  NG.back = function () { var l = layers[layers.length - 1]; if (l) { l.close(); return true; } return false; };
  if (tg && tg.BackButton) { try { tg.BackButton.onClick(function () { NG.back(); }); } catch (e) {} }
  NG.screenCount = function () { return screens; };

  /** Pushes a full screen (slides in). Returns { el, close }. */
  NG.push = function (node, o) {
    o = o || {};
    var s = NG.el('<div class="screen"></div>'); s.appendChild(node); NG.col.appendChild(s);
    screens++; if (NG.onScreens) NG.onScreens(screens);
    var closed = false, rm;
    function close() {
      if (closed) return; closed = true; rm();
      s.classList.add("out"); setTimeout(function () { s.remove(); }, 210);
      screens--; if (NG.onScreens) NG.onScreens(screens);
      if (o.onClose) o.onClose();
    }
    rm = NG.addLayer(close);
    return { el: s, close: close };
  };
  /** Standard top bar for a pushed screen. */
  NG.topbar = function (title, o) {
    o = o || {};
    var t = NG.el('<div class="top"><button class="bk" aria-label="back">' + NG.svg("back") + '</button><div class="ttl"></div><button class="rt"></button></div>');
    var ttl = t.querySelector(".ttl");
    if (o.html) ttl.innerHTML = title; else ttl.textContent = title;
    var rt = t.querySelector(".rt");
    if (o.right) { rt.innerHTML = o.right; if (o.rightClass) rt.className = "rt " + o.rightClass; } else rt.style.visibility = "hidden";
    return t;
  };

  /** Bottom sheet. bind(sheetEl, close). Returns close(). */
  NG.sheet = function (html, bind, o) {
    o = o || {};
    var dim = NG.el('<div class="dim"></div>'), sh = NG.el('<div class="sheet ' + (o.cls || "") + '"><div class="grab"></div>' + html + "</div>");
    document.body.appendChild(dim); document.body.appendChild(sh);
    var closed = false, rm;
    function close(cb) {
      if (closed) return; closed = true; rm();
      sh.classList.add("down"); dim.style.transition = "opacity .2s"; dim.style.opacity = 0;
      setTimeout(function () { sh.remove(); dim.remove(); if (typeof cb === "function") cb(); if (o.onClose) o.onClose(); }, 230);
    }
    rm = NG.addLayer(close);
    dim.addEventListener("click", function () { close(); });
    if (bind) bind(sh, close);
    return close;
  };
  /** Simple action sheet: items = [{label, cls, fn}] — the sheet closes first, then fn runs. */
  NG.actions = function (items, title) {
    var html = (title ? '<div class="shd">' + NG.esc(title) + "</div>" : "") + items.map(function (it, i) { return '<button class="item ' + (it.cls || "") + '" data-i="' + i + '">' + NG.esc(it.label) + "</button>"; }).join("") + '<button class="item" data-i="x">انصراف</button>';
    return NG.sheet(html, function (sh, close) {
      Array.prototype.forEach.call(sh.querySelectorAll(".item"), function (b) {
        b.onclick = function () { var i = b.getAttribute("data-i"); if (i === "x") return close(); close(function () { items[+i].fn(); }); };
      });
    });
  };
  NG.confirm = function (title, text, okLabel, fn, danger) {
    NG.sheet('<div class="shd">' + NG.esc(title) + '</div><div class="ctx">' + NG.esc(text) + '</div><button class="item ' + (danger === false ? "blue" : "red") + '" id="ok">' + NG.esc(okLabel) + '</button><button class="item" id="no">انصراف</button>', function (sh, close) {
      sh.querySelector("#no").onclick = function () { close(); };
      sh.querySelector("#ok").onclick = function () { close(fn); };
    });
  };

  /* ---------------------------------------------------------- file pick */
  NG.pickImage = function (cb) {
    var inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = function () { var f = inp.files && inp.files[0]; if (f) cb(f); };
    inp.click();
  };

  NG.emptyHtml = function (icon, title, text) { return '<div class="empty"><div class="big">' + NG.svg(icon) + "</div><h3>" + title + "</h3>" + (text || "") + "</div>"; };
  NG.share = function (kind, id) {
    var key = kind === "uid" ? "uid" : "pid";
    var body = {}; body[key] = id;
    var code = (kind === "uid" ? "u_" : (String(id).indexOf("pp:") === 0 ? "q_" : "p_")) + String(id).replace(/^pp:/, "");
    var link = NG.bot ? "https://t.me/" + NG.bot + "?startapp=" + code : "";
    var tg = NG.tg;
    /* the fallbacks, in order: Telegram's share sheet with the link → the phone's own share sheet → copy the link */
    function viaLink() {
      if (!link) return NG.toast("لینک اشتراک‌گذاری آماده نیست؛ چند لحظه بعد دوباره امتحان کن.");
      try {
        if (tg && tg.openTelegramLink) { tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent("نوا گرام")); return; }
      } catch (e) {}
      try { if (navigator.share) { navigator.share({ url: link }).catch(function () {}); return; } } catch (e) {}
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(link).then(function () { NG.toast("لینک کپی شد ✓"); }, function () { NG.toast(link); }); return; }
      } catch (e) {}
      NG.toast(link);
    }
    NG.haptic();
    NG.api("share", body).then(function (r) {
      if (!r.ok || !r.data || !r.data.id) return viaLink();
      if (tg && tg.shareMessage) {
        var settled = false, off = function () { try { tg.offEvent("shareMessageFailed", failed); tg.offEvent("shareMessageSent", sent); } catch (e) {} };
        var failed = function () { if (settled) return; settled = true; off(); viaLink(); };
        var sent = function () { if (settled) return; settled = true; off(); NG.haptic("ok"); NG.toast("ارسال شد ✓"); };
        try {
          tg.onEvent("shareMessageFailed", failed); tg.onEvent("shareMessageSent", sent);
          tg.shareMessage(r.data.id, function (ok) { if (ok) sent(); });
          setTimeout(off, 120000);
          return;
        } catch (e) { off(); }
      }
      viaLink();
    }).catch(function () { viaLink(); });
  };
  NG.confetti = function () {
    var cols = ["#feda75", "#fa7e1e", "#d62976", "#962fbf", "#4f5bd5", "#2ecc71", "#fff"];
    for (var i = 0; i < 36; i++) {
      (function (i) {
        var c = document.createElement("div"); c.className = "conf";
        c.style.left = 10 + Math.random() * 80 + "vw"; c.style.background = cols[i % cols.length];
        c.style.setProperty("--dx", (Math.random() * 160 - 80) + "px"); c.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
        c.style.animationDelay = Math.random() * 0.35 + "s"; c.style.animationDuration = 1.4 + Math.random() * 1.2 + "s";
        document.body.appendChild(c); setTimeout(function () { c.remove(); }, 3200);
      })(i);
    }
  };
})();
