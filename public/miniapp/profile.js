/* نوا گرام — profile (self + others), follow lists, gifts (Telegram-gifts look), edit profile, chat request. */
(function () {
  "use strict";
  var NG = window.NG, $ = NG.$, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  /* ------------------------------------------------------------ me */
  NG.refreshMe = function () {
    return NG.api("me").then(function (r) {
      if (!r.ok) return null;
      var old = NG.me; NG.me = r.data.me;
      NG.emit("me", { old: old, me: NG.me });
      return NG.me;
    }).catch(function () { return null; });
  };

  /* -------------------------------------------------------- gift catalog */
  var catalog = { at: 0, items: [], all: [], balance: 0 };
  NG.getCatalog = function (force) {
    if (!force && catalog.items.length && Date.now() - catalog.at < 60000) return Promise.resolve(catalog);
    return NG.api("gift_catalog").then(function (r) {
      if (r.ok) catalog = { at: Date.now(), items: r.data.items, all: r.data.all || r.data.items, balance: r.data.balance };
      return catalog;
    });
  };
  function giftDef(id) { return catalog.all.filter(function (g) { return g.id === id; })[0]; }

  function giftCard(def, o) {
    o = o || {};
    var pat = ""; for (var i = 0; i < 16; i++) pat += "<span>" + def.pattern + "</span>";
    var c = el('<div class="gc' + (o.cls ? " " + o.cls : "") + '" style="background:linear-gradient(160deg,' + def.c1 + "," + def.c2 + ')"><div class="pat">' + pat + '</div>' +
      (o.price != null ? '<div class="pr">' + num(o.price) + " رلیک</div>" : "") + '<div class="gem"><div class="em">' + def.emoji + "</div></div>" +
      (o.name ? '<div class="nm">' + esc(def.name) + "</div>" : "") + (o.by ? '<div class="by">از ' + esc(o.by) + "</div>" : "") +
      (def.unique ? '<div class="tagu">✨ یکتا</div>' : "") + (o.sold && def.soldOut ? '<div class="sold">فروخته شد</div>' : "") + "</div>");
    if (def.anim) NG.mountAnim(c.querySelector(".gem"), def.anim); // original Telegram animation (TGS / WebM)
    return c;
  }

  /* ---------------------------------------------------------- send gift */
  function clientId() {
    var a = new Uint8Array(10); try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 10; i++) a[i] = Math.random() * 256; }
    return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join("") + Date.now().toString(36);
  }
  NG.openGiftSheet = function (to) {
    NG.getCatalog(true).then(function (cat) {
      if (!cat.items.length) return NG.toast("فعلاً هدیه‌ای فعال نیست.");
      NG.sheet('<div class="shd">هدیه برای ' + esc(NG.nameOf(to)) + '</div><div class="gbal"><span>موجودی شما: <b id="bal">' + num(cat.balance) + '</b> رلیک</span><span>روی هدیه بزن</span></div><div class="scroll"><div class="gifts" id="gg"></div><div class="pad" style="padding-top:12px"><input class="inp" id="gm" maxlength="100" placeholder="پیام (اختیاری)"></div><div class="anonrow"><div>ارسال ناشناس<small>اگه روشن باشه، فرستنده «ناشناس» نشون داده می‌شه</small></div><button class="tg" id="anon" aria-label="anonymous"></button></div><div class="gerr" id="ge"></div></div><div class="pad"><button class="btn blue tall" id="go" style="width:100%" disabled>یک هدیه انتخاب کن</button></div>', function (sh, close) {
        var grid = sh.querySelector("#gg"), go = sh.querySelector("#go"), err = sh.querySelector("#ge"), msg = sh.querySelector("#gm");
        var sel = null, cid = null, busy = false, anon = false;
        var at = sh.querySelector("#anon"); at.onclick = function () { anon = !anon; at.classList.toggle("on", anon); NG.haptic("sel"); };
        cat.items.forEach(function (g) {
          var c = giftCard(g, { price: g.price, name: true, sold: true });
          if (g.soldOut) c.classList.add("dis");
          c.onclick = function () {
            if (g.soldOut) { NG.haptic("err"); return NG.toast("این هدیه‌ی یکتا قبلاً فروخته شده."); }
            Array.prototype.forEach.call(grid.children, function (x) { x.classList.remove("sel"); });
            c.classList.add("sel"); sel = g; cid = clientId(); NG.haptic("sel");
            go.disabled = false; go.textContent = "ارسال " + g.name + " — " + num(g.price) + " رلیک"; err.classList.remove("show");
          };
          grid.appendChild(c);
        });
        go.onclick = function () {
          if (!sel || busy) return; busy = true; go.disabled = true; var label = go.textContent; go.textContent = "…"; err.classList.remove("show");
          NG.api("gift_send", { id: to.id, giftId: sel.id, message: msg.value, clientId: cid, anonymous: anon }).then(function (r) {
            busy = false;
            if (r.ok) {
              NG.me.relic = r.data.balance; NG.emit("me", { old: NG.me, me: NG.me });
              catalog.balance = r.data.balance;
              NG.haptic("ok");
              close(function () {
                var f = document.createElement("div"); f.className = "fly"; f.textContent = sel.emoji; document.body.appendChild(f); setTimeout(function () { f.remove(); }, 1700);
                NG.confetti(); NG.toast("🎁 هدیه برای " + NG.nameOf(to) + " ارسال شد");
                NG.emit("gift:sent", { to: to.id });
              });
              return;
            }
            go.disabled = false; go.textContent = label; NG.haptic("err");
            if (r.data && r.data.error === "insufficient") {
              err.textContent = "رلیک کافی نیست. قیمت این هدیه " + num(sel.price) + " رلیکه و موجودی تو " + num(catalog.balance) + " رلیکه. از داخل ربات می‌تونی رلیک تهیه کنی.";
              NG.getCatalog(true).then(function (c2) { var b = sh.querySelector("#bal"); if (b) b.textContent = num(c2.balance); });
            } else if (r.data && r.data.error === "sold_out") {
              err.textContent = NG.errText(r); NG.getCatalog(true);
            } else err.textContent = NG.errText(r);
            err.classList.add("show");
          }).catch(function () { busy = false; go.disabled = false; go.textContent = label; NG.netErr(); });
        };
      }, { cls: "tall2" });
    });
  };

  function giftDetail(g, ownerBrief, isMe) {
    var def = giftDef(g.giftId); if (!def) return;
    NG.sheet('<div class="gdetail" id="gd"></div><div class="pad">' + (isMe ? '<button class="btn blue tall" id="rg" style="width:100%;margin-bottom:8px">🎁 ارسال این هدیه به یه نفر دیگه</button>' : "") + '<button class="btn tall" id="cl" style="width:100%">بستن</button></div>', function (sh, close) {
      var box = sh.querySelector("#gd");
      box.appendChild(giftCard(def, { cls: "lg", name: true }));
      if (g.from) {
        var w = el('<div class="who"><span style="color:var(--muted)">از</span><b>' + esc(NG.nameOf(g.from)) + "</b></div>");
        var r = NG.ring(g.from, { noStory: true }); r.setAttribute("data-fixed", "1"); r.className = "ring none"; w.insertBefore(r, w.firstChild);
        w.onclick = function () { close(function () { NG.openProfile(g.from.id); }); };
        box.appendChild(w);
      } else {
        box.appendChild(el('<div class="who" style="cursor:default"><span style="color:var(--muted)">از</span><b>ناشناس</b></div>'));
      }
      if (g.message) box.appendChild(el('<div class="msg">«' + esc(g.message) + "»</div>"));
      box.appendChild(el('<div style="color:var(--muted);font-size:12px">' + NG.ago(g.at) + "</div>"));
      sh.querySelector("#cl").onclick = function () { close(); };
      var rg = sh.querySelector("#rg");
      if (rg) rg.onclick = function () { close(function () { regiftPick(g, def); }); };
    });
  }

  /* ------------------------------------------------- send a gift I own to somebody else */
  function regiftPick(g, def) {
    NG.sheet('<div class="shd">این هدیه رو برای کی بفرستم؟</div><div class="pad"><input class="inp" id="q" placeholder="نام یا یوزرنیم کاربر…" autocomplete="off"></div><div class="scroll" id="rs" style="min-height:120px"></div>', function (sh, close) {
      var q = sh.querySelector("#q"), box = sh.querySelector("#rs"), t = 0, seq = 0;
      function run() {
        var my = ++seq, v = q.value.trim();
        if (!v) { box.innerHTML = '<div class="note" style="padding:20px">اسم یا یوزرنیم رو بنویس.</div>'; return; }
        NG.api("search", { q: v }).then(function (r) {
          if (my !== seq) return;
          box.innerHTML = "";
          var items = (r.ok && r.data.items) || [];
          if (!items.length) { box.innerHTML = '<div class="note" style="padding:20px">کاربری پیدا نشد.</div>'; return; }
          items.slice(0, 20).forEach(function (u) {
            if (NG.me && u.id === NG.me.id) return;
            var row = el('<button class="item" style="display:flex;align-items:center;gap:10px;width:100%;text-align:start"></button>');
            var ring = NG.ring(u, { noStory: true }); ring.className = "ring none"; ring.style.width = "36px"; ring.style.height = "36px";
            row.appendChild(ring); row.appendChild(el("<span>" + esc(NG.nameOf(u)) + "</span>"));
            row.onclick = function () { close(function () { regiftConfirm(g, def, u); }); };
            box.appendChild(row);
          });
        }).catch(NG.netErr);
      }
      q.oninput = function () { clearTimeout(t); t = setTimeout(run, 280); };
      run(); setTimeout(function () { try { q.focus(); } catch (e) {} }, 300);
    }, { cls: "tall2" });
  }
  function regiftConfirm(g, def, to) {
    NG.sheet('<div class="shd">ارسال ' + esc(def.name) + " به " + esc(NG.nameOf(to)) + '</div><div class="ctx">این هدیه از پروفایل تو برداشته می‌شه و میره پروفایل ' + esc(NG.nameOf(to)) + '. رایگانه و برگشت نداره.</div><div class="pad" style="padding-top:12px"><input class="inp" id="gm" maxlength="100" placeholder="پیام (اختیاری)"></div><div class="anonrow"><div>ارسال ناشناس<small>فرستنده «ناشناس» نشون داده می‌شه</small></div><button class="tg" id="anon"></button></div><div class="pad"><button class="btn blue tall" id="go" style="width:100%;margin-top:12px">ارسال</button></div><button class="item" id="no">انصراف</button>', function (sh, close) {
      var anon = false, at = sh.querySelector("#anon"), go = sh.querySelector("#go");
      at.onclick = function () { anon = !anon; at.classList.toggle("on", anon); NG.haptic("sel"); };
      sh.querySelector("#no").onclick = function () { close(); };
      go.onclick = function () {
        go.disabled = true; go.textContent = "…";
        NG.api("gift_regift", { gift: g.id, id: to.id, message: sh.querySelector("#gm").value, anonymous: anon }).then(function (r) {
          if (!r.ok) { go.disabled = false; go.textContent = "ارسال"; NG.haptic("err"); return NG.toast(NG.errText(r)); }
          NG.haptic("ok");
          close(function () { NG.confetti(); NG.toast("🎁 هدیه برای " + NG.nameOf(to) + " ارسال شد"); NG.emit("gift:regifted", { gift: g.id }); });
        }).catch(function () { go.disabled = false; go.textContent = "ارسال"; NG.netErr(); });
      };
    });
  }

  /* ----------------------------------------------------------- chat request */
  NG.requestChat = function (b) {
    NG.sheet('<div class="shd">درخواست چت ناشناس</div><div class="ctx">به <b style="color:var(--text)">' + esc(NG.nameOf(b)) + '</b> درخواست چت ناشناس فرستاده می‌شه.<br>اگه قبول کنه، ۱ رلیک از هر دو نفر کم می‌شه.</div><div class="pad"><button class="btn blue tall" id="go" style="width:100%">ارسال درخواست</button></div><button class="item" id="no" style="margin-top:6px">انصراف</button>', function (sh, close) {
      sh.querySelector("#no").onclick = function () { close(); };
      var go = sh.querySelector("#go");
      go.onclick = function () {
        go.disabled = true; go.textContent = "…";
        NG.api("request", { id: b.id }).then(function (r) {
          close();
          if (!r.ok) return NG.fail(r);
          var s = r.data.status;
          if (s === "sent") { NG.haptic("ok"); NG.toast("✅ درخواست ارسال شد"); NG.emit("chat:requested", b.id); }
          else if (s === "already_pending") { NG.toast("قبلاً برای این کاربر درخواست دادی. منتظر جوابش باش."); NG.emit("chat:requested", b.id); }
          else if (s === "rate_limited") NG.toast("تعداد درخواست‌هات زیاد بوده؛ کمی بعد دوباره امتحان کن.");
          else if (s === "no_balance") NG.toast("موجودی رلیکت کافی نیست (۱ رلیک لازمه).");
          else if (s === "in_chat") NG.toast("الان توی یه چت هستی. اول چت رو تموم کن.");
          else NG.toast("این کاربر الان در دسترس نیست.");
        }).catch(function () { close(); NG.netErr(); });
      };
    });
  };

  /* ----------------------------------------------------- photo viewer */
  function viewAvatar(p) {
    if (!p.av) return;
    var v = el('<div class="pavatar-lg"></div>'); v.appendChild(NG.img(p.av, "on"));
    v.firstChild.classList.add("on");
    document.body.appendChild(v);
    var rm, closed = false;
    function close() { if (closed) return; closed = true; rm(); v.classList.add("out"); setTimeout(function () { v.remove(); }, 200); }
    rm = NG.addLayer(close); v.onclick = close;
  }
  NG.viewAvatar = viewAvatar;

  /* ---------------------------------------------------------- follow lists */
  NG.openFollows = function (p, start) {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar(esc(NG.nameOf(p)), { html: true });
    var tabs = el('<div class="ptabs" style="border-top:0;border-bottom:.5px solid var(--sep)"><button data-t="followers">' + num(p.followers) + ' دنبال‌کننده</button><button data-t="following">' + num(p.following) + ' دنبال‌شونده</button><div class="ind"></div></div>');
    var body = el("<div></div>");
    w.appendChild(top); w.appendChild(tabs); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var cur = null, cursor = null, more = false, loading = false;
    function row(u) {
      var r = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(u)) + NG.vb(u) + "</b><span>" + (u.username ? esc(u.name) : "") + "</span></div></div>");
      r.insertBefore(NG.ring(u), r.firstChild);
      r.querySelector(".ring").onclick = function (e) { if (u.story) { e.stopPropagation(); NG.openStories([u.id], 0); } };
      r.onclick = function () { NG.openProfile(u.id); };
      if (!u.isMe) {
        var b = el('<button class="fbtn' + (u.iFollow ? " gray" : "") + '">' + (u.iFollow ? "دنبال می‌کنی" : "دنبال کردن") + "</button>");
        b.onclick = function (e) {
          e.stopPropagation(); var want = !u.iFollow; u.iFollow = want;
          b.className = "fbtn" + (want ? " gray" : ""); b.textContent = want ? "دنبال می‌کنی" : "دنبال کردن";
          NG.api("follow", { id: u.id, follow: want }).then(function (rr) { if (!rr.ok) { u.iFollow = !want; b.className = "fbtn" + (u.iFollow ? " gray" : ""); b.textContent = u.iFollow ? "دنبال می‌کنی" : "دنبال کردن"; NG.toast(NG.errText(rr)); } else NG.emit("follow", { id: u.id, following: rr.data.following, followers: rr.data.followers }); }).catch(NG.netErr);
        };
        r.appendChild(b);
      }
      return r;
    }
    function load(reset) {
      if (loading) return; loading = true;
      if (reset) { body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>'; cursor = null; }
      NG.api("follows", { id: p.id, type: cur, before: cursor || undefined }).then(function (r) {
        loading = false;
        if (reset) body.innerHTML = "";
        var mb = body.querySelector(".moreb"); if (mb) mb.remove();
        if (!r.ok) return NG.toast(NG.errText(r));
        r.data.items.forEach(function (u) { body.appendChild(row(u)); });
        cursor = r.data.next; more = r.data.hasMore;
        if (!body.children.length) body.innerHTML = NG.emptyHtml("user", cur === "followers" ? "هنوز دنبال‌کننده‌ای نیست" : "هنوز کسی رو دنبال نمی‌کنه", "");
        if (more) { var b = el('<button class="moreb" style="width:100%;padding:14px;color:var(--blue);font-weight:600">بیشتر</button>'); b.onclick = function () { load(false); }; body.appendChild(b); }
      }).catch(function () { loading = false; NG.netErr(); });
    }
    function sel(t) {
      cur = t; var ind = tabs.querySelector(".ind");
      ind.style.transform = "translateX(" + (t === "followers" ? 100 : 0) + "%)"; // RTL: first button sits on the right
      Array.prototype.forEach.call(tabs.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === t); });
      load(true);
    }
    tabs.querySelectorAll("button")[0].onclick = function () { sel("followers"); };
    tabs.querySelectorAll("button")[1].onclick = function () { sel("following"); };
    sel(start || "followers");
  };

  /* ------------------------------------------------ private page: requests */
  NG.openFollowRequests = function (onChange) {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("درخواست‌های دنبال کردن");
    var body = el("<div></div>");
    w.appendChild(top); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var cursor = null, loading = false;
    function row(u) {
      var r = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(u)) + NG.vb(u) + "</b><span>" + (u.username ? esc(u.name) : "") + "</span></div></div>");
      r.insertBefore(NG.ring(u, { noStory: true }), r.firstChild);
      r.querySelector(".ring").onclick = function (e) { e.stopPropagation(); NG.openProfile(u.id); };
      var ok = el('<button class="fbtn">تأیید</button>'), no = el('<button class="fbtn gray">حذف</button>');
      function answer(accept) {
        ok.disabled = no.disabled = true;
        NG.api("follow_respond", { id: u.id, accept: accept }).then(function (rr) {
          if (!rr.ok) { ok.disabled = no.disabled = false; return NG.toast(NG.errText(rr)); }
          r.remove(); if (onChange) onChange(rr.data);
          if (!body.children.length) body.innerHTML = NG.emptyHtml("user", "درخواستی نمونده", "");
        }).catch(function () { ok.disabled = no.disabled = false; NG.netErr(); });
      }
      ok.onclick = function (e) { e.stopPropagation(); answer(true); };
      no.onclick = function (e) { e.stopPropagation(); answer(false); };
      r.onclick = function () { NG.openProfile(u.id); };
      r.appendChild(ok); r.appendChild(no);
      return r;
    }
    function load(reset) {
      if (loading) return; loading = true;
      if (reset) { body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>'; cursor = null; }
      NG.api("follow_requests", { before: cursor || undefined }).then(function (r) {
        loading = false;
        if (reset) body.innerHTML = "";
        var mb = body.querySelector(".moreb"); if (mb) mb.remove();
        if (!r.ok) return NG.toast(NG.errText(r));
        r.data.items.forEach(function (u) { body.appendChild(row(u)); });
        cursor = r.data.next;
        if (!body.children.length) body.innerHTML = NG.emptyHtml("user", "درخواستی نیست", "");
        if (r.data.hasMore) { var b = el('<button class="moreb" style="width:100%;padding:14px;color:var(--blue);font-weight:600">بیشتر</button>'); b.onclick = function () { load(false); }; body.appendChild(b); }
      }).catch(function () { loading = false; NG.netErr(); });
    }
    load(true);
  };

  /* ---------------------------------------------- owner: switch account */
  NG.openAccounts = function () {
    NG.api("accounts").then(function (r) {
      if (!r.ok) return NG.toast(NG.errText(r));
      var d = r.data, list = [{ id: d.main.id, name: d.main.name, av: d.main.av, verified: d.main.verified, main: true }].concat(d.items);
      NG.sheet('<div class="shd">تعویض اکانت</div><div id="acc" style="max-height:60vh;overflow:auto"></div>', function (sh, close) {
        var box = sh.querySelector("#acc");
        list.forEach(function (a) {
          var cur = a.id === d.current;
          var row = el('<div class="row"><div class="t"><b>' + esc(a.name) + NG.vb(a) + "</b><span>" + (a.main ? "اکانت اصلی تو" : "ممبر پیش‌فرض") + "</span></div>" + (cur ? '<span style="color:var(--blue);font-weight:800">✓</span>' : "") + "</div>");
          row.insertBefore(NG.ring(a, { noStory: true }), row.firstChild);
          row.onclick = function () { if (cur) return close(); NG.setActAs(a.main ? null : a.id); close(function () { location.reload(); }); };
          box.appendChild(row);
        });
        if (!d.items.length) box.appendChild(el('<div class="empty" style="padding:20px 24px">هنوز ممبر پیش‌فرضی نساختی. از پنل ادمین → تنظیمات ربات → 🎭 ممبرهای پیش‌فرض بساز.</div>'));
      });
    }).catch(NG.netErr);
  };

  /* ---------------------------------------------------------------- profile */
  /** Builds a profile page. o = { tab: true } for the bottom-bar tab, else it is pushed as a screen. */
  function profileView(id, o) {
    o = o || {};
    var isMeId = NG.me && id === NG.me.id;
    var root = el('<div style="min-height:100%"></div>');
    var topEl = el('<div class="ptop"></div>');
    var head = el("<div></div>"), hl = el("<div></div>"), tabsEl = el("<div></div>"), body = el('<div class="pbody"></div>');
    root.appendChild(topEl); root.appendChild(head); root.appendChild(hl); root.appendChild(tabsEl); root.appendChild(body);
    var P = null, tab = o.tabState || "posts", pids = [], gridCursor = null, gridMore = false, gridLoading = false, closeFn = null, coinEl = null;
    function setRelic(n) { if (P && P.isMe) P.relic = n; if (coinEl) { var b = coinEl.querySelector("b"); if (b) b.textContent = num(n || 0); } }

    function renderTop() {
      topEl.innerHTML = "";
      var left = el('<div style="display:flex;align-items:center;gap:10px;min-width:0"></div>');
      if (!o.tab) { var bk = el('<button class="ib" aria-label="back">' + svg("back") + "</button>"); bk.onclick = function () { if (closeFn) closeFn(); }; left.appendChild(bk); }
      var nm = P ? NG.nameOf(P) : "…";
      var u = el('<div class="u"><span>' + esc(nm) + "</span>" + NG.vb(P) + "</div>");
      left.appendChild(u); topEl.appendChild(left);
      // owner / admins: tap the name to switch account (like Instagram) and work as a default member
      if (o.tab && P && P.isMe && NG.staff) { u.insertAdjacentHTML("beforeend", NG.svg("chevD", "")); u.style.cursor = "pointer"; u.onclick = function () { NG.openAccounts(); }; }
      var act = el('<div class="act"></div>');
      if (P && P.isMe) {
        // Relic balance in the corner: always the server's number (refreshed by the live "me" poll)
        coinEl = el('<button class="coinchip" aria-label="relic"><span class="cn">🪙</span><b>' + num(P.relic || 0) + "</b></button>");
        coinEl.onclick = function () { NG.toast("موجودی رلیک تو: " + num((NG.me && NG.me.relic != null ? NG.me.relic : P.relic) || 0)); };
        act.appendChild(coinEl);
        var add = el('<button class="ib" aria-label="new">' + svg("plus") + "</button>"); add.onclick = function () { NG.composeMenu(); };
        var mn = el('<button class="ib" aria-label="menu">' + svg("menu") + "</button>"); mn.onclick = function () { ownMenu(P); };
        act.appendChild(add); act.appendChild(mn);
      } else if (P) {
        var dt = el('<button class="ib" aria-label="more">' + svg("dots") + "</button>"); dt.onclick = function () { otherMenu(P); };
        act.appendChild(dt);
      }
      topEl.appendChild(act);
    }

    function renderHead() {
      head.innerHTML = "";
      if (!P) { head.innerHTML = '<div class="phead"><div class="ring none"><div class="in sk"></div></div><div class="stats"><div><b>–</b><span>پست</span></div><div><b>–</b><span>دنبال‌کننده</span></div><div><b>–</b><span>دنبال‌شونده</span></div></div></div>'; return; }
      var h = el('<div class="phead"></div>');
      var ring = NG.ring(P); ring.setAttribute("data-fixed", "1"); ring.style.cursor = "pointer";
      if (P.isMe && P.story) { ring.className = "ring"; }
      ring.onclick = function () {
        if (P.story && !(P.isMe && !P.story)) NG.openStories([P.id], 0);
        else if (P.av) viewAvatar(P);
        else if (P.isMe) NG.changeProfilePhoto();
      };
      h.appendChild(ring);
      var st = el('<div class="stats"><div class="sp"><b>' + num(P.posts) + "</b><span>پست</span></div><div class=\"sf\"><b>" + num(P.followers) + "</b><span>دنبال‌کننده</span></div><div class=\"sg\"><b>" + num(P.following) + "</b><span>دنبال‌شونده</span></div></div>");
      st.querySelector(".sf").onclick = function () { if (P.locked) return NG.toast("این پیج خصوصیه؛ بعد از تأیید صاحبش می‌تونی ببینی."); NG.openFollows(P, "followers"); };
      st.querySelector(".sg").onclick = function () { if (P.locked) return NG.toast("این پیج خصوصیه؛ بعد از تأیید صاحبش می‌تونی ببینی."); NG.openFollows(P, "following"); };
      h.appendChild(st); head.appendChild(h);

      var info = [];
      if (P.age != null && P.age !== "") info.push(num(P.age) + " ساله");
      if (P.city || P.province) info.push([P.city, P.province].filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; }).join("، "));
      var bio = el('<div class="pbio"><div class="n">' + esc(P.name) + NG.vb(P) + "</div>" + (info.length ? '<div class="s">' + esc(info.join(" • ")) + "</div>" : "") +
        (P.bio ? '<div class="d">' + esc(P.bio) + "</div>" : (P.isMe ? '<div class="s">بیوگرافی نداری — از «ویرایش پروفایل» اضافه کن.</div>' : "")) + "</div>");
      head.appendChild(bio);
      if (P.isMe) {
        var notes = [];
        if (P.photoPending) notes.push("📷 عکس جدیدت در انتظار تأیید مالکه؛ بعد از تأیید خودکار جایگزین می‌شه.");
        if (P.pendingName) notes.push("✏️ درخواست تغییر نام به «" + P.pendingName + "» در انتظار تأیید مالکه.");
        if (P.pendingAge) notes.push("✏️ درخواست تغییر سن به " + num(P.pendingAge) + " در انتظار تأیید مالکه.");
        if (notes.length) head.appendChild(el('<div class="note" style="padding-top:0">' + notes.map(esc).join("<br>") + "</div>"));
      }
      var btns = el('<div class="pbtns"></div>');
      if (P.isMe) {
        var e1 = el('<button class="btn">ویرایش پروفایل</button>'); e1.onclick = function () { NG.openEdit(); };
        var e2 = el('<button class="btn">اشتراک‌گذاری پروفایل</button>'); e2.onclick = function () { NG.share("uid", P.id); };
        btns.appendChild(e1); btns.appendChild(e2);
        if (P.isPrivate && P.requests > 0) {
          var rq = el('<button class="btn blue" style="margin-top:8px;width:100%;flex:none">درخواست‌های دنبال کردن (' + num(P.requests) + ")</button>");
          rq.onclick = function () { NG.openFollowRequests(function (d) { P.requests = d.requests; P.followers = d.followers; NG.me = Object.assign(NG.me || {}, { requests: d.requests, followers: d.followers }); renderHead(); }); };
          head.appendChild(rq);
        }
      } else {
        var f = el('<button class="btn"></button>');
        function fl() {
          var on = P.iFollow || P.requested; f.className = "btn" + (on ? "" : " blue");
          f.textContent = P.iFollow ? "دنبال می‌کنی" : P.requested ? "درخواست شده" : (P.isPrivate ? "درخواست دنبال کردن" : (P.followsMe ? "دنبال کردن متقابل" : "دنبال کردن"));
        }
        fl();
        f.onclick = function () {
          // private page: the first tap sends a REQUEST (waits for approval); tapping again cancels it
          var want = !(P.iFollow || P.requested), was = { f: P.iFollow, r: P.requested, n: P.followers, l: P.locked };
          if (want) { if (P.isPrivate) P.requested = true; else { P.iFollow = true; P.followers += 1; } }
          else { if (P.iFollow) P.followers -= 1; P.iFollow = false; P.requested = false; if (P.isPrivate) P.locked = true; }
          fl(); NG.haptic();
          var sf = head.querySelector(".sf b"); if (sf) sf.textContent = num(P.followers);
          if (!!P.locked !== !!was.l) renderBody(true);
          NG.api("follow", { id: P.id, follow: want }).then(function (r) {
            if (!r.ok) { P.iFollow = was.f; P.requested = was.r; P.followers = was.n; var lc = !!P.locked !== !!was.l; P.locked = was.l; fl(); if (sf) sf.textContent = num(P.followers); if (lc) renderBody(true); return NG.toast(NG.errText(r)); }
            P.iFollow = r.data.following; P.requested = !!r.data.requested; P.followers = r.data.followers;
            var lockedNow = !!P.isPrivate && !P.iFollow; var changed = lockedNow !== !!P.locked; P.locked = lockedNow;
            fl(); if (sf) sf.textContent = num(P.followers); if (changed) renderBody(true);
            NG.emit("follow", { id: P.id, following: P.iFollow, followers: P.followers });
          }).catch(function () { P.iFollow = was.f; P.requested = was.r; P.followers = was.n; P.locked = was.l; fl(); renderBody(true); NG.netErr(); });
        };
        var c = el('<button class="btn"></button>');
        function cs() {
          c.disabled = P.chat !== "none"; c.classList.toggle("chatlive", P.chat === "with_you");
          c.innerHTML = P.chat === "with_you" ? '<span class="chatnow"><i></i>در حال چت با شما هست</span>' : svg("chat", "ico") + (P.chat === "requested" ? "درخواست ارسال شد" : P.chat === "busy" ? "در چت دیگری است" : "درخواست چت");
          var sv = c.querySelector("svg"); if (sv) sv.style.width = "18px";
        }
        cs(); c.onclick = function () { NG.requestChat(P); };
        var g = el('<button class="btn sq" aria-label="gift">' + svg("gift") + "</button>"); g.onclick = function () { NG.openGiftSheet(P); };
        btns.appendChild(f); btns.appendChild(c); btns.appendChild(g);
        P._cs = cs;
      }
      head.appendChild(btns);
    }

    function renderHighlights() {
      hl.innerHTML = "";
      if (!P) return;
      var list = P.highlights || [];
      if (!list.length && !P.isMe) return;
      var row = el('<div class="hl"></div>');
      if (P.isMe) {
        var nw = el('<div class="h"><div class="hc"><div class="i" style="background:transparent">' + svg("plus", "ico") + '</div></div><div class="t">جدید</div></div>');
        nw.onclick = function () { NG.openHighlightEditor(null, function () { reload(); }); };
        row.appendChild(nw);
      }
      list.forEach(function (h) {
        var n = el('<div class="h"><div class="hc"><div class="i sk"></div></div><div class="t">' + esc(h.title) + "</div></div>");
        if (h.cover) n.querySelector(".i").appendChild(NG.img(h.cover)); else n.querySelector(".i").classList.remove("sk");
        n.onclick = function () { NG.openHighlight(h.id, P, function () { reload(); }); };
        row.appendChild(n);
      });
      hl.appendChild(row);
    }

    function renderTabs() {
      tabsEl.innerHTML = "";
      if (!P) return;
      var t = el('<div class="ptabs"><button data-t="posts" class="' + (tab === "posts" ? "on" : "") + '">' + svg("grid") + '</button><button data-t="gifts" class="' + (tab === "gifts" ? "on" : "") + '">' + svg("gift") + '</button><div class="ind" style="transform:translateX(' + (tab === "posts" ? 100 : 0) + '%)"></div></div>');
      // RTL: first button is on the right; the indicator slides between the two halves
      t.querySelectorAll("button")[0].onclick = function () { setTab("posts"); };
      t.querySelectorAll("button")[1].onclick = function () { setTab("gifts"); };
      tabsEl.appendChild(t);
    }
    function setTab(t) {
      if (tab === t) return; tab = t; NG.haptic("sel");
      var ind = tabsEl.querySelector(".ind"); if (ind) ind.style.transform = "translateX(" + (t === "posts" ? 100 : 0) + "%)";
      Array.prototype.forEach.call(tabsEl.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === t); });
      renderBody(true);
    }

    function tile(it, idx) {
      var t = el('<div class="tile sk"></div>');
      if (it.src) t.appendChild(NG.img(it.src)); else t.classList.remove("sk");
      if (it.comments || it.likes) t.appendChild(el('<div class="badge">' + (it.comments ? svg("comment", "") : "") + "</div>"));
      var badge = t.querySelector(".badge"); if (badge && !it.comments) badge.remove();
      t.onclick = function () { NG.haptic("sel"); NG.openPosts(pids, pids.indexOf(it.pid), NG.nameOf(P)); };
      return t;
    }
    function loadGrid(reset) {
      if (gridLoading) return; gridLoading = true;
      var g = body.querySelector(".grid");
      if (reset) { pids = []; gridCursor = null; }
      NG.api("posts", { id: id, before: reset ? undefined : gridCursor || undefined }).then(function (r) {
        gridLoading = false;
        if (tab !== "posts") return;
        var sp = body.querySelector(".more-spin"); if (sp) sp.remove();
        if (!r.ok) return NG.toast(NG.errText(r));
        if (reset) body.innerHTML = '<div class="grid"></div>'; g = body.querySelector(".grid");
        r.data.items.forEach(function (it) { if (pids.indexOf(it.pid) >= 0) return; pids.push(it.pid); g.appendChild(tile(it)); });
        var withAt = r.data.items.filter(function (x) { return x.at; });
        if (withAt.length) gridCursor = withAt[withAt.length - 1].at;
        gridMore = r.data.hasMore;
        if (!pids.length) {
          body.innerHTML = P && P.isMe ? NG.emptyHtml("camera", "اولین پستت رو بذار", "عکس‌هایی که می‌ذاری اینجا و توی فید نشون داده می‌شه.") : NG.emptyHtml("camera", "هنوز پستی نیست", "");
          if (P && P.isMe) { var b = el('<div style="padding:0 40px"><button class="btn blue tall" style="width:100%">ساخت پست</button></div>'); b.querySelector("button").onclick = function () { NG.composeMenu(); }; body.appendChild(b); }
        } else if (gridMore) {
          var s = el('<div class="more-spin"><div class="spin"></div></div>'); body.appendChild(s);
          if ("IntersectionObserver" in window) { var io = new IntersectionObserver(function (en) { if (en[0].isIntersecting) { io.disconnect(); loadGrid(false); } }, { root: o.tab ? NG.pages.profile : root.parentNode, rootMargin: "400px 0px" }); io.observe(s); }
        }
      }).catch(function () { gridLoading = false; NG.netErr(); });
    }
    function loadGifts() {
      body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>';
      Promise.all([NG.getCatalog(), NG.api("gifts", { id: id })]).then(function (res) {
        if (tab !== "gifts") return;
        var r = res[1]; body.innerHTML = "";
        if (!r.ok) return NG.toast(NG.errText(r));
        if (P && !P.isMe) {
          var sg = el('<div class="sendgift"><div class="em">🎁</div><div><b>ارسال هدیه به ' + esc(NG.nameOf(P)) + "</b><span>با رلیک، هدیه‌ی متحرک بفرست</span></div></div>");
          sg.onclick = function () { NG.openGiftSheet(P); }; body.appendChild(sg);
        }
        var grid = el('<div class="gifts"></div>');
        r.data.items.forEach(function (g) {
          var def = giftDef(g.giftId); if (!def) return;
          var c = giftCard(def, { by: g.from ? NG.nameOf(g.from) : "ناشناس", cls: "" });
          c.onclick = function () { giftDetail(g, P, P && P.isMe); };
          grid.appendChild(c);
        });
        if (!grid.children.length) body.appendChild(el(NG.emptyHtml("gift", P && P.isMe ? "هنوز هدیه‌ای نگرفتی" : "هنوز هدیه‌ای نگرفته", P && !P.isMe ? "اولین نفری باش که بهش هدیه می‌ده." : "")));
        else body.appendChild(grid);
      }).catch(NG.netErr);
    }
    function renderBody(reset) {
      if (P && P.locked && tab === "posts") { body.innerHTML = '<div class="empty" style="padding:50px 30px"><h3 style="font-size:18px">🔒 این پیج خصوصیه</h3>برای دیدن پست‌ها و استوری‌ها باید درخواست دنبال کردن بدی و صاحب پیج تأیید کنه.</div>'; return; }
      if (!P) { body.innerHTML = '<div class="grid">' + new Array(10).join('<div class="tile sk"></div>') + "</div>"; return; }
      if (tab === "gifts") loadGifts(); else loadGrid(reset !== false);
    }

    var seq = 0;
    function reload() {
      var my = ++seq;
      return NG.api("profile", { id: id }).then(function (r) {
        if (my !== seq) return;
        if (!r.ok) {
          if (r.status === 404) { root.innerHTML = '<div class="fatal"><h3>پیدا نشد</h3>این پروفایل در دسترس نیست.</div>'; if (closeFn) { var b = el('<div class="top"><button class="bk">' + svg("back") + "</button></div>"); b.querySelector("button").onclick = closeFn; root.insertBefore(b, root.firstChild); } return; }
          return NG.fail(r);
        }
        var firstTime = !P; P = r.data.profile;
        if (P.isMe) NG.me = Object.assign(NG.me || {}, P);
        renderTop(); renderHead(); renderHighlights(); renderTabs();
        if (firstTime || o.tab) renderBody(true); else renderBody(false);
      }).catch(NG.netErr);
    }
    // instant paint for the own profile (data is already there)
    if (isMeId && NG.me && o.tab) { P = NG.me; renderTop(); renderHead(); renderHighlights(); renderTabs(); renderBody(true); } else { renderTop(); renderHead(); renderBody(); }

    // live updates from other parts of the app
    var offs = [];
    NG.on("post:deleted", function () { if (P) { P.posts = Math.max(0, P.posts - 1); } if (document.body.contains(root)) { reloadSoft(); } });
    NG.on("post:created", function () { if (document.body.contains(root) && P && P.isMe) reloadSoft(); });
    NG.on("chat:requested", function (uid) { if (P && P.id === uid) { P.chat = "requested"; if (P._cs) P._cs(); } });
    NG.on("gift:regifted", function () { if (P && P.isMe && tab === "gifts" && document.body.contains(root)) { P.gifts = Math.max(0, (P.gifts || 1) - 1); renderBody(true); } });
    NG.on("gift:sent", function (d) { if (P && P.id === d.to && tab === "gifts" && document.body.contains(root)) { P.gifts++; renderBody(true); } });
    function reloadSoft() { if (tab === "posts") { reload(); } else reload(); }

    function ownMenu(p) {
      NG.actions([
        { label: "ویرایش پروفایل", fn: function () { NG.openEdit(); } },
        { label: "ساخت پست", fn: function () { NG.composeMenu("post"); } },
        { label: "ساخت استوری", fn: function () { NG.createStory(); } },
        { label: "آرشیو استوری‌ها", fn: function () { NG.openArchive(); } },
        { label: p.isPrivate ? "پیج خصوصی: روشن (غیرخصوصی کردن)" : "خصوصی کردن پیج", fn: function () { togglePrivate(p); } },
        ].concat(NG.staff ? [{ label: "تعویض اکانت", fn: function () { NG.openAccounts(); } }] : []).concat([
        { label: "رلیک: " + num(p.relic || 0) + " • سطح: " + (p.level || "-"), cls: "", fn: function () {} }
      ]));
    }
    function togglePrivate(p) {
      var on = !p.isPrivate;
      NG.confirm(on ? "خصوصی کردن پیج" : "غیرخصوصی کردن پیج",
        on ? "از این به بعد فقط کسانی که تأیید کنی پست‌ها، استوری‌ها و لیست دنبال‌کننده‌هات رو می‌بینن. دنبال‌کننده‌های فعلی می‌مونن." : "پیجت دوباره برای همه باز میشه و درخواست‌های منتظر خودکار تأیید می‌شن.",
        on ? "خصوصی کن" : "غیرخصوصی کن", function () {
          NG.api("set_private", { on: on }).then(function (r) {
            if (!r.ok) return NG.toast(NG.errText(r));
            P.isPrivate = r.data.isPrivate; P.requests = r.data.requests; P.followers = r.data.followers;
            NG.me = Object.assign(NG.me || {}, { isPrivate: P.isPrivate, requests: P.requests, followers: P.followers });
            renderHead(); NG.toast(P.isPrivate ? "پیجت خصوصی شد 🔒" : "پیجت عمومی شد");
          }).catch(NG.netErr);
        }, false);
    }
    function otherMenu(p) {
      NG.actions([
        { label: "ارسال هدیه", fn: function () { NG.openGiftSheet(p); } },
        { label: "درخواست چت ناشناس", fn: function () { NG.requestChat(p); } },
        { label: "اشتراک‌گذاری پروفایل", fn: function () { NG.share("uid", p.id); } }
      ]);
    }

    return { node: root, reload: reload, setRelic: setRelic, setClose: function (f) { closeFn = f; }, get profile() { return P; } };
  }

  NG.openProfile = function (id) {
    if (!id) return;
    if (NG.me && id === NG.me.id) {
      while (NG.back()) { /* close every layer */ }
      NG.selectTab("profile", true);
      return;
    }
    var v = profileView(id, {});
    var scr = NG.push(v.node);
    v.setClose(scr.close);
    v.reload();
  };
  NG.profileView = profileView;

  /* ---------------------------------------------------------- edit profile */
  var USER_ERR = { taken: "این یوزرنیم قبلاً انتخاب شده", too_short: "حداقل ۵ کاراکتر", too_long: "حداکثر ۲۴ کاراکتر", bad_chars: "فقط حروف انگلیسی، عدد، _ و . مجازه", bad_dots: "نقطه نباید اول/آخر یا پشت‌سرهم باشه", reserved: "این یوزرنیم رزرو شده" };

  function requestSheet(field, current) {
    var isName = field === "nickname";
    NG.sheet('<div class="shd">درخواست تغییر ' + (isName ? "نام" : "سن") + '</div><div class="ctx">' + (isName ? "نام جدید رو فارسی بنویس (حداکثر ۳۲ حرف)." : "سن جدید رو بین ۹ تا ۹۹ وارد کن.") + '<br>این درخواست برای مالک ربات فرستاده می‌شه و بعد از تأییدش اعمال می‌شه.</div><div class="pad"><input class="inp" id="rv" ' + (isName ? 'maxlength="32" placeholder="نام جدید"' : 'inputmode="numeric" maxlength="2" placeholder="سن جدید"') + ' value="' + esc(current || "") + '"></div><div class="gerr" id="re"></div><div class="pad" style="margin-top:10px"><button class="btn blue tall" id="rs" style="width:100%">ارسال درخواست</button></div>', function (sh, close) {
      var inp = sh.querySelector("#rv"), err = sh.querySelector("#re"), go = sh.querySelector("#rs");
      go.onclick = function () {
        go.disabled = true; err.classList.remove("show");
        NG.api("request_change", { field: field, value: inp.value.trim() }).then(function (r) {
          go.disabled = false;
          if (!r.ok) { err.textContent = NG.errText(r); err.classList.add("show"); NG.haptic("err"); return; }
          NG.haptic("ok"); close(function () { NG.toast("✅ درخواستت برای مالک ارسال شد"); NG.refreshMe(); });
        }).catch(function () { go.disabled = false; NG.netErr(); });
      };
    });
  }

  NG.openEdit = function () {
    var m = NG.me, orig = { u: m.username || "", b: m.bio || "" };
    var w = el('<div style="min-height:100%;display:flex;flex-direction:column"></div>');
    var top = NG.topbar("ویرایش پروفایل", { right: "تأیید", rightClass: "done" });
    w.appendChild(top);
    var av = el('<div class="editav"><div class="holder"></div><button class="chg">تغییر عکس پروفایل</button></div>');
    var ring = NG.ring(m, { noStory: true }); ring.className = "ring none"; ring.style.width = ring.style.height = "86px"; ring.style.cursor = "pointer";
    av.querySelector(".holder").appendChild(ring);
    av.querySelector(".chg").onclick = function () { NG.changeProfilePhoto(); }; ring.onclick = function () { NG.changeProfilePhoto(); };
    w.appendChild(av);
    if (m.photoPending) w.appendChild(el('<div class="note" style="padding-top:0;text-align:center">📷 عکس جدیدت در انتظار تأیید مالکه.</div>'));
    var f1 = el('<div class="field-row"><label>نام</label><div class="v"><span class="ro">' + esc(m.name) + '</span>' + (m.pendingName ? '<div class="msg">در انتظار تأیید: ' + esc(m.pendingName) + "</div>" : "") + '<div class="lnk">درخواست تغییر نام</div></div></div>');
    f1.querySelector(".lnk").onclick = function () { requestSheet("nickname", m.name); };
    var f2 = el('<div class="field-row"><label>یوزرنیم</label><div class="v"><input class="ltr" dir="ltr" maxlength="25" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="@username" value="' + esc(orig.u ? "@" + orig.u : "") + '"><div class="line"></div><div class="msg"></div></div></div>');
    var f3 = el('<div class="field-row"><label>سن</label><div class="v"><span class="ro">' + (m.age != null ? num(m.age) : "-") + '</span>' + (m.pendingAge ? '<div class="msg">در انتظار تأیید: ' + num(m.pendingAge) + "</div>" : "") + '<div class="lnk">درخواست تغییر سن</div></div></div>');
    f3.querySelector(".lnk").onclick = function () { requestSheet("age", m.age != null ? String(m.age) : ""); };
    var f4 = el('<div class="field-row"><label>بیوگرافی</label><div class="v"><textarea rows="4" maxlength="300" placeholder="بیوگرافی">' + esc(orig.b) + '</textarea><div class="line"></div><div class="cnt"></div></div></div>');
    var f5 = el('<div class="field-row"><label>محل</label><div class="v"><span class="ro">' + esc([m.city, m.province].filter(Boolean).join("، ") || "-") + "</span></div></div>");
    [f1, f2, f3, f4, f5].forEach(function (f) { w.appendChild(f); });
    w.appendChild(el('<div class="note">عکس پروفایل و تغییر نام یا سن بعد از تأیید مالک اعمال می‌شن. یوزرنیم و بیوگرافی فوری ذخیره می‌شن. یوزرنیم مخصوص نوا گرامه و جدا از یوزرنیم تلگرامته؛ هر تغییری اینجا توی پروفایل ربات هم دیده می‌شه.</div>'));
    var ui = f2.querySelector("input"), um = f2.querySelector(".msg"), bi = f4.querySelector("textarea"), bc = f4.querySelector(".cnt"), dn = top.querySelector(".done");
    var okName = true, seq = 0, t;
    function cnt() { bc.textContent = [].concat(bi.value).join("").length + " / 300"; }
    function clean() { return ui.value.trim().replace(/^@/, ""); }
    function changed() { dn.disabled = !(okName && (clean() !== orig.u || bi.value.trim() !== orig.b)); }
    function setMsg(txt, kind) { um.textContent = txt; um.className = "msg " + (kind || ""); }
    cnt(); bi.addEventListener("input", function () { cnt(); changed(); });
    ui.addEventListener("input", function () {
      var v = clean(); clearTimeout(t); okName = true; changed();
      if (!v || v === orig.u) { setMsg(""); changed(); return; }
      okName = false; changed(); setMsg("در حال بررسی…");
      var my = ++seq;
      t = setTimeout(function () {
        NG.api("check_username", { username: v }).then(function (r) {
          if (my !== seq) return;
          if (!r.ok) return setMsg("خطا در بررسی", "err");
          if (r.data.available) { okName = true; setMsg("✓ " + v + " آزاده", "ok"); } else setMsg(USER_ERR[r.data.reason] || "نامعتبر", "err");
          changed();
        });
      }, 350);
    });
    dn.disabled = true;
    var scr = NG.push(w);
    top.querySelector(".bk").onclick = scr.close;
    dn.onclick = function () {
      dn.disabled = true;
      var chain = Promise.resolve(true), nu = clean();
      if (nu !== orig.u && nu) chain = chain.then(function () { return NG.api("set_username", { username: nu }).then(function (r) { if (!r.ok) { setMsg(USER_ERR[r.data.error] || "ذخیره نشد", "err"); NG.haptic("err"); return false; } return true; }); });
      chain = chain.then(function (ok) { if (!ok) return false; if (bi.value.trim() === orig.b) return true; return NG.api("set_bio", { bio: bi.value }).then(function (r) { if (!r.ok) { NG.toast(NG.errText(r, "بیوگرافی ذخیره نشد.")); return false; } return true; }); });
      chain.then(function (ok) { if (!ok) { dn.disabled = false; return; } NG.haptic("ok"); NG.toast("پروفایل ذخیره شد ✓"); NG.refreshMe().then(function () { scr.close(); }); }).catch(function () { dn.disabled = false; NG.netErr(); });
    };
  };
})();
