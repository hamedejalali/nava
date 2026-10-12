/* نوا گرام — compose: image cropper (pan / pinch / zoom), new-post flow, profile photo change, "+" menu. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, svg = NG.svg;

  /* ---------------------------------------------------------------- cropper */
  /**
   * NG.cropFlow(file, opts, cb)
   *   opts = { ratios:[{k,r}], out:<output width px>, title, cta, round, caption:<max length|0>, captionHint }
   *   cb(res, done)  res = { data:"data:image/jpeg;base64,…", caption, ratio:"4:5", close }, done(true) closes the screen, done(false) re-enables the button.
   */
  NG.cropFlow = function (file, opts, cb) {
    var ratios = opts.ratios, cur = ratios[0];
    var url = URL.createObjectURL(file), img = new Image();
    var w = el('<div style="height:100%;display:flex;flex-direction:column;background:#000;color:#fff"></div>');
    var top = NG.topbar(opts.title || "برش عکس", { right: opts.cta || "تأیید", rightClass: "done" });
    top.style.background = "#000"; top.style.borderBottomColor = "#222"; top.querySelector(".ttl").style.color = "#fff";
    top.querySelector(".bk").style.color = "#fff";
    var wrap = el('<div class="cropwrap"><div class="crop' + (opts.round ? " round" : "") + '"><canvas></canvas></div></div>');
    var box = wrap.firstChild, cv = box.firstChild, ctx = cv.getContext("2d");
    w.appendChild(top); w.appendChild(wrap);
    var chips = null;
    if (ratios.length > 1) {
      chips = el('<div class="ratios"></div>');
      ratios.forEach(function (x) {
        var b = el('<button class="' + (x === cur ? "on" : "") + '">' + esc(x.label || x.k) + "</button>");
        b.onclick = function () { cur = x; Array.prototype.forEach.call(chips.children, function (c) { c.classList.remove("on"); }); b.classList.add("on"); NG.haptic("sel"); layout(true); };
        chips.appendChild(b);
      });
      w.appendChild(chips);
    }
    var zoomRow = el('<div class="zoom"><span style="font-size:12px;opacity:.7">−</span><input type="range" min="1" max="4" step="0.01" value="1"><span style="font-size:12px;opacity:.7">+</span></div>');
    var zr = zoomRow.querySelector("input");
    w.appendChild(zoomRow);
    var ta = null, cnt = null;
    if (opts.caption) {
      var cwrap = el('<div style="background:#000;padding:0 16px 14px"><textarea rows="2" maxlength="' + opts.caption + '" placeholder="' + esc(opts.captionHint || "کپشن…") + '" style="width:100%;background:#1a1a1a;border:0;border-radius:10px;color:#fff;padding:10px 12px;font-size:15px;resize:none;outline:0"></textarea></div>');
      ta = cwrap.firstChild; w.appendChild(cwrap);
    }
    var scr = NG.push(w, { onClose: function () { try { URL.revokeObjectURL(url); } catch (e) {} } });
    top.querySelector(".bk").onclick = scr.close;
    var done = top.querySelector(".done"); done.disabled = true;

    var BW = 0, BH = 0, iw = 0, ih = 0, z = 1, cx = 0, cy = 0, base = 1, dpr = Math.min(2, window.devicePixelRatio || 1);
    function s() { return base * z; }
    function clamp() {
      var sw = iw * s(), sh = ih * s();
      var minx = BW - sw / 2, maxx = sw / 2, miny = BH - sh / 2, maxy = sh / 2;
      cx = Math.min(maxx, Math.max(minx, cx)); cy = Math.min(maxy, Math.max(miny, cy));
    }
    function draw() {
      if (!iw) return;
      clamp(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#111"; ctx.fillRect(0, 0, BW, BH);
      var sw = iw * s(), sh = ih * s();
      ctx.drawImage(img, cx - sw / 2, cy - sh / 2, sw, sh);
    }
    function layout(reset) {
      var avail = wrap.clientWidth - 32, availH = wrap.clientHeight - 32;
      if (avail <= 0 || availH <= 0 || !iw) return;
      var W = Math.min(avail, 420), H = W / cur.r;
      if (H > availH) { H = availH; W = H * cur.r; }
      BW = Math.floor(W); BH = Math.floor(H);
      box.style.width = BW + "px"; box.style.height = BH + "px";
      cv.width = BW * dpr; cv.height = BH * dpr;
      base = Math.max(BW / iw, BH / ih);
      if (reset) { z = 1; zr.value = 1; cx = BW / 2; cy = BH / 2; }
      draw();
    }
    img.onload = function () {
      iw = img.naturalWidth; ih = img.naturalHeight;
      if (iw < 50 || ih < 50) { NG.toast(NG.errText({ data: { error: "bad_image" } })); scr.close(); return; }
      done.disabled = false; setTimeout(function () { layout(true); }, 60); requestAnimationFrame(function () { layout(true); });
    };
    img.onerror = function () { NG.toast(NG.errText({ data: { error: "bad_image" } })); scr.close(); };
    img.src = url;
    window.addEventListener("resize", function rs() { if (!document.body.contains(w)) return window.removeEventListener("resize", rs); layout(false); });

    // gestures: 1 pointer = pan, 2 pointers = pinch
    var ptrs = {}, last = null;
    function pts() { return Object.keys(ptrs).map(function (k) { return ptrs[k]; }); }
    box.addEventListener("pointerdown", function (e) { try { box.setPointerCapture(e.pointerId); } catch (x) {} ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; last = null; });
    box.addEventListener("pointermove", function (e) {
      if (!ptrs[e.pointerId]) return;
      var before = pts().map(function (p) { return { x: p.x, y: p.y }; });
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var now = pts();
      if (now.length === 1 && before.length === 1) { cx += now[0].x - before[0].x; cy += now[0].y - before[0].y; draw(); }
      else if (now.length >= 2 && before.length >= 2) {
        var d0 = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y), d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
        if (d0 > 0) { z = Math.min(4, Math.max(1, z * d1 / d0)); zr.value = z; }
        cx += (now[0].x + now[1].x) / 2 - (before[0].x + before[1].x) / 2; cy += (now[0].y + now[1].y) / 2 - (before[0].y + before[1].y) / 2; draw();
      }
    });
    function up(e) { delete ptrs[e.pointerId]; }
    box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
    box.addEventListener("wheel", function (e) { e.preventDefault(); z = Math.min(4, Math.max(1, z * (e.deltaY < 0 ? 1.07 : 0.93))); zr.value = z; draw(); }, { passive: false });
    zr.oninput = function () {
      var old = s(); var nz = parseFloat(zr.value) || 1; var f = base * nz / old;
      // zoom around the centre of the box
      cx = BW / 2 + (cx - BW / 2) * f; cy = BH / 2 + (cy - BH / 2) * f; z = nz; draw();
    };

    function exportJpeg() {
      var W = opts.out || 1080, H = Math.round(W / cur.r), f = W / BW;
      var c = document.createElement("canvas"); c.width = W; c.height = H;
      var x = c.getContext("2d"); x.fillStyle = "#111"; x.fillRect(0, 0, W, H);
      var sw = iw * s() * f, sh = ih * s() * f;
      x.imageSmoothingQuality = "high";
      x.drawImage(img, cx * f - sw / 2, cy * f - sh / 2, sw, sh);
      var q = 0.88, d = c.toDataURL("image/jpeg", q);
      while (d.length > 2.6 * 1024 * 1024 && q > 0.4) { q -= 0.1; d = c.toDataURL("image/jpeg", q); }
      return d;
    }
    done.onclick = function () {
      if (!iw) return;
      done.disabled = true;
      var res = { data: exportJpeg(), caption: ta ? ta.value.trim() : "", ratio: cur.k, close: scr.close };
      var finished = false;
      cb(res, function (ok) { if (finished) return; if (ok) { finished = true; scr.close(); } else done.disabled = false; });
    };
    return scr;
  };

  /* ---------------------------------------------------------- new post */
  var POST_RATIOS = [{ k: "4:5", r: 0.8, label: "۴:۵" }, { k: "1:1", r: 1, label: "۱:۱" }, { k: "1.91:1", r: 1.91, label: "افقی" }];

  NG.createPost = function () {
    NG.pickImage(function (file) {
      NG.cropFlow(file, { ratios: POST_RATIOS, out: 1080, title: "پست جدید", cta: "بعدی" }, function (res, done) {
        done(false);
        postDetails(res);
      });
    });
  };

  function toggleRow(title, sub, on, fn) {
    var r = el('<div class="switch"><div>' + esc(title) + "<small>" + esc(sub) + '</small></div><button class="tg' + (on ? " on" : "") + '" aria-label="toggle"></button></div>');
    var b = r.querySelector(".tg");
    b.onclick = function () { on = !on; b.classList.toggle("on", on); NG.haptic("sel"); fn(on); };
    return r;
  }

  function postDetails(res) {
    var w = el('<div style="min-height:100%;display:flex;flex-direction:column"></div>');
    var top = NG.topbar("پست جدید", { right: "اشتراک", rightClass: "done" });
    var cmp = el('<div class="cmp"><div class="th"></div><textarea maxlength="1000" placeholder="کپشن بنویس…"></textarea></div>');
    cmp.querySelector(".th").style.backgroundImage = "url(" + res.data + ")";
    var ta = cmp.querySelector("textarea");
    var cnt = el('<div class="cmp-cnt">0 / 1000</div>');
    ta.oninput = function () { cnt.textContent = ta.value.length + " / 1000"; };
    var st = { noComments: false, hideLikes: false };
    w.appendChild(top); w.appendChild(cmp); w.appendChild(cnt);
    w.appendChild(toggleRow("بستن نظرات", "کسی نمی‌تونه زیر این پست نظر بذاره", false, function (v) { st.noComments = v; }));
    w.appendChild(toggleRow("مخفی کردن تعداد لایک‌ها", "فقط خودت تعداد رو می‌بینی", false, function (v) { st.hideLikes = v; }));
    w.appendChild(el('<div class="note">پست‌ها نیازی به تأیید مالک ندارن و بلافاصله توی فید و پروفایلت نمایش داده می‌شن. بعداً می‌تونی کپشن و تنظیمات رو از منوی پست عوض کنی.</div>'));
    var scr = NG.push(w);
    top.querySelector(".bk").onclick = scr.close;
    var go = top.querySelector(".done"), busy = false;
    go.onclick = function () {
      if (busy) return; busy = true; go.disabled = true; go.textContent = "…";
      NG.api("post_create", { image: res.data, caption: ta.value.trim(), ratio: res.ratio, noComments: st.noComments, hideLikes: st.hideLikes }).then(function (r) {
        busy = false; go.disabled = false; go.textContent = "اشتراک";
        if (!r.ok) return NG.toast(NG.errText(r));
        NG.haptic("ok"); NG.toast("✅ پست منتشر شد");
        var it = NG.upsert(r.data.item);
        scr.close(); res.close();
        if (NG.me) NG.me.posts = (NG.me.posts || 0) + 1;
        NG.emit("post:created", it);
        if (NG.selectTab) NG.selectTab("home", false);
      }).catch(function () { busy = false; go.disabled = false; go.textContent = "اشتراک"; NG.netErr(); });
    };
  }

  /* ----------------------------------------------------- profile photo */
  NG.changeProfilePhoto = function () {
    NG.pickImage(function (file) {
      NG.cropFlow(file, { ratios: [{ k: "1:1", r: 1 }], out: 1080, title: "عکس پروفایل", cta: "ثبت", round: true }, function (res, done) {
        NG.api("upload_photo", { image: res.data }).then(function (r) {
          if (!r.ok) { done(false); return NG.toast(NG.errText(r)); }
          done(true); NG.haptic("ok");
          if (r.data.status === "approved") NG.toast("✅ عکس پروفایلت عوض شد");
          else NG.toast("📷 عکس برای تأیید مالک ارسال شد؛ بعد از تأیید خودکار جایگزین می‌شه");
          NG.refreshMe();
        }).catch(function () { done(false); NG.netErr(); });
      });
    });
  };

  /* --------------------------------------------------------------- "+" menu */
  NG.composeMenu = function (kind) {
    if (kind === "post") return NG.createPost();
    if (kind === "story") return NG.createStory();
    NG.actions([
      { label: "پست جدید", fn: NG.createPost },
      { label: "استوری جدید", fn: NG.createStory },
      { label: "تغییر عکس پروفایل", fn: NG.changeProfilePhoto }
    ], "ساخت");
  };
})();
