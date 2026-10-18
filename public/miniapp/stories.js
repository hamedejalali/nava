/* نوا گرام — stories (24h), story viewer, archive, highlights (create / edit name + cover / play). */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;
  var DUR = 5000;

  /* ------------------------------------------------------------- viewer */
  /** groups = [{ id, data: {owner, stories, title?}|null }]; o.loader(id) -> Promise<data|null>; o.kind = "story" | "highlight" | "archive" */
  function openViewer(groups, gi, o) {
    o = o || {};
    var root = el('<div class="sv"><div class="frame"></div></div>'), frame = root.firstChild;
    document.body.appendChild(root);
    var fromTap = NG.lastTap && Date.now() - NG.lastTap.t < 1500 ? NG.lastTap : null;
    if (fromTap) { root.style.transformOrigin = fromTap.x + "px " + fromTap.y + "px"; root.classList.add("grow"); }
    var firstShow = true;
    var closed = false, rm, raf = 0, last = 0, elapsed = 0, paused = false, ready = false, hold = 0, g = null, si = 0, token = 0;
    var viewed = {}, prevGi = gi;

    function close() {
      if (closed) return; closed = true; rm(); cancelAnimationFrame(raf);
      root.classList.add("out"); setTimeout(function () { root.remove(); }, 270);
      if (o.onClose) o.onClose();
    }
    rm = NG.addLayer(close);

    function groupState(gr) {
      var s = gr.data.stories; if (!s.length) return 0;
      return s.every(function (x) { return x.seen; }) ? 1 : 2;
    }
    function leaveGroup() {
      if (!g || o.kind !== "story") return;
      NG.emit("story:seen", { uid: g.data.owner.id, state: groupState(g) });
    }

    function loadGroup(i) {
      var gr = groups[i]; if (!gr) return Promise.resolve(null);
      if (gr.data) return Promise.resolve(gr);
      return o.loader(gr.id).then(function (d) { if (!d) return null; gr.data = d; return gr; }).catch(function () { return null; });
    }
    function preload(i) { if (groups[i] && !groups[i].data && o.loader) loadGroup(i); }

    function showGroup(i, startAt) {
      var my = ++token;
      ready = false; paused = true;
      frame.innerHTML = '<div class="ld"><div class="spin" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></div></div>';
      loadGroup(i).then(function (gr) {
        if (my !== token || closed) return;
        if (!gr || !gr.data.stories.length) {
          // nothing to show for this person (expired meanwhile): go on / close
          if (groups[i + 1]) { gi = i + 1; return showGroup(gi, "first"); }
          return close();
        }
        leaveGroup();
        g = gr; gi = i;
        var list = g.data.stories;
        si = startAt === "last" ? list.length - 1 : startAt === "first" ? 0 : (function () { for (var k = 0; k < list.length; k++) if (!list[k].seen) return k; return 0; })();
        var dir = gi > prevGi ? -1 : 1; prevGi = gi;
        renderStory();
        if (!firstShow) { frame.style.setProperty("--gdir", (dir * 36) + "px"); frame.classList.remove("gin"); void frame.offsetWidth; frame.classList.add("gin"); }
        firstShow = false;
        preload(gi + 1);
      });
    }

    function renderStory() {
      var my = ++token; var list = g.data.stories, s = list[si], owner = g.data.owner, mine = NG.me && owner.id === NG.me.id;
      elapsed = 0; last = 0; ready = false; paused = false;
      // keep the previous picture underneath until the new one is loaded (no black flash between stories)
      var oldImg = frame.querySelector("img.m");
      Array.prototype.slice.call(frame.children).forEach(function (n) { if (n !== oldImg) n.remove(); });
      var bars = el('<div class="bars"></div>');
      list.forEach(function (_, k) { bars.appendChild(el("<i" + (k < si ? ' class="done"' : "") + "><b></b></i>")); });
      var head = el('<div class="shead"><div class="rr"></div><div class="nm"><span>' + esc(g.data.title || NG.nameOf(owner)) + "</span>" + (g.data.title ? "" : NG.vb(owner)) + '<span class="tm">' + (g.data.title ? "" : NG.ago(s.at)) + '</span></div><button class="mo" aria-label="more">' + svg("dots") + '</button><button class="xx" aria-label="close">' + svg("close") + "</button></div>");
      var ring = NG.ring(owner, { noStory: true }); ring.className = "ring none"; head.querySelector(".rr").replaceWith(ring);
      ring.style.cursor = "pointer"; ring.onpointerdown = function (e) { e.stopPropagation(); };
      ring.onclick = function () { var id = owner.id; close(); setTimeout(function () { NG.openProfile(id); }, 240); };
      var img = NG.img(s.src, "m"); img.classList.remove("fadeimg");
      var dropOld = function () { if (oldImg && oldImg.parentNode) { oldImg.classList.add("gone"); setTimeout(function () { if (oldImg.parentNode) oldImg.remove(); }, 280); } };
      img.onload = function () { img.classList.add("on"); if (my === token) ready = true; dropOld(); };
      img.onerror = function () { if (my === token) ready = true; dropOld(); };
      img.style.transition = "opacity .2s";
      frame.appendChild(img);
      frame.appendChild(bars); frame.appendChild(head);
      if (s.caption) frame.appendChild(el('<div class="scap">' + esc(s.caption) + "</div>"));
      var canEdit = mine && o.kind !== "archive-readonly";
      head.querySelector(".xx").onclick = close;
      var mo = head.querySelector(".mo");
      if (canEdit || o.kind === "highlight") mo.onclick = function () { storyMenu(s, mine); }; else mo.style.visibility = "hidden";
      Array.prototype.forEach.call(head.querySelectorAll("button"), function (b) { b.onpointerdown = function (e) { e.stopPropagation(); }; });
      if (mine && o.kind !== "highlight") {
        var vb = el('<div class="sviews"><button>' + svg("eye") + "<span>" + num(s.views || 0) + " بازدید</span></button></div>");
        vb.firstChild.onpointerdown = function (e) { e.stopPropagation(); };
        vb.firstChild.onclick = function () { viewersSheet(s); };
        frame.appendChild(vb);
        var sc = frame.querySelector(".scap"); if (sc) sc.style.paddingBottom = "calc(64px + env(safe-area-inset-bottom))";
      }
      if (!mine && o.kind === "story" && !viewed[s.id]) {
        viewed[s.id] = true; s.seen = true;
        NG.api("story_view", { storyId: s.id });
      }
      if (!raf) raf = requestAnimationFrame(tick);
      NG.haptic();
    }

    function setBar(f) {
      var b = frame.querySelectorAll(".bars i")[si]; if (b) b.firstChild.style.width = Math.min(100, f * 100) + "%";
    }
    function tick(ts) {
      raf = 0; if (closed) return;
      if (!last) last = ts;
      var dt = ts - last; last = ts;
      if (ready && !paused && !hold) { elapsed += dt; setBar(elapsed / DUR); if (elapsed >= DUR) { next(); } }
      if (!closed) raf = requestAnimationFrame(tick);
    }

    function next() {
      var list = g.data.stories;
      if (si < list.length - 1) { si++; renderStory(); }
      else {
        leaveGroup();
        if (groups[gi + 1]) showGroup(gi + 1, "first"); else close();
      }
    }
    function prev() {
      if (si > 0) { si--; renderStory(); }
      else if (groups[gi - 1]) { showGroup(gi - 1, "first"); }
      else { elapsed = 0; setBar(0); }
    }

    /* gestures: hold = pause, tap = next / previous, swipe down = close */
    var d = null;
    frame.addEventListener("pointerdown", function (e) { d = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false }; paused = true; });
    frame.addEventListener("pointermove", function (e) {
      if (!d) return; var dy = e.clientY - d.y, dx = e.clientX - d.x;
      if (Math.abs(dy) > 10 || Math.abs(dx) > 10) d.moved = true;
      if (dy > 0 && Math.abs(dy) > Math.abs(dx)) frame.style.transform = "translateY(" + dy * 0.6 + "px) scale(" + (1 - Math.min(dy, 300) / 1500) + ")";
    });
    function up(e) {
      if (!d) return;
      var dy = e.clientY - d.y, dur = Date.now() - d.t, r = frame.getBoundingClientRect(), rel = (e.clientX - r.left) / r.width, was = d; d = null;
      frame.style.transform = "";
      paused = false;
      if (dy > 110 && Math.abs(dy) > Math.abs(e.clientX - was.x)) return close();
      if (!was.moved && dur < 260) { if (rel > 0.7) prev(); else next(); }
    }
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", function () { d = null; paused = false; frame.style.transform = ""; });

    /* menus */
    function storyMenu(s, mine) {
      hold++;
      var items = [];
      if (o.kind === "highlight") {
        if (mine) {
          items.push({ label: "ویرایش هایلایت", fn: function () { var id = groups[0].id; close(); setTimeout(function () { NG.openHighlightEditor(id, o.onChange); }, 240); } });
          items.push({ label: "حذف هایلایت", cls: "red", fn: function () { NG.confirm("حذف هایلایت؟", "فقط هایلایت پاک می‌شه؛ استوری‌ها در آرشیو می‌مونن.", "حذف", function () { NG.api("highlight_delete", { hid: groups[0].id }).then(function (r) { if (r.ok) { NG.toast("هایلایت حذف شد"); close(); if (o.onChange) o.onChange(); } else NG.toast(NG.errText(r)); }); }); } });
        }
      } else {
        items.push({ label: "افزودن به هایلایت", fn: function () { var sid = s.id; close(); setTimeout(function () { NG.openHighlightEditor(null, o.onChange, [sid]); }, 240); } });
        items.push({ label: "حذف استوری", cls: "red", fn: function () {
          NG.confirm("حذف استوری؟", "این استوری برای همیشه پاک می‌شه.", "حذف", function () {
            NG.api("story_delete", { storyId: s.id }).then(function (r) {
              if (!r.ok) return NG.toast(NG.errText(r));
              NG.haptic("ok");
              var list = g.data.stories; list.splice(si, 1);
              if (!list.length) { NG.emit("story:seen", { uid: g.data.owner.id, state: 0 }); NG.emit("story:posted"); close(); return; }
              if (si >= list.length) si = list.length - 1;
              NG.emit("story:posted"); renderStory();
            });
          });
        } });
      }
      if (!items.length) { hold--; return; }
      NG.actions(items);
      // resume when the sheet is gone
      var iv = setInterval(function () { if (!document.querySelector(".sheet")) { clearInterval(iv); hold = Math.max(0, hold - 1); } }, 200);
    }
    function viewersSheet(s) {
      hold++;
      NG.sheet('<div class="shd">بازدیدکننده‌ها</div><div class="scroll" id="vl"><div class="more-spin"><div class="spin"></div></div></div>', function (sh, closeSheet) {
        NG.api("story_viewers", { storyId: s.id }).then(function (r) {
          var box = sh.querySelector("#vl"); if (!box) return; box.innerHTML = "";
          if (!r.ok) return NG.toast(NG.errText(r));
          sh.querySelector(".shd").textContent = num(r.data.count) + " بازدید";
          if (!r.data.viewers.length) box.innerHTML = '<div class="empty" style="padding:40px">هنوز کسی ندیده.</div>';
          r.data.viewers.forEach(function (u) {
            var row = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(u)) + "</b><span>" + (u.username ? esc(u.name) : "") + "</span></div></div>");
            var rg = NG.ring(u, { noStory: true }); rg.className = "ring none"; row.insertBefore(rg, row.firstChild);
            row.onclick = function () { closeSheet(function () { close(); setTimeout(function () { NG.openProfile(u.id); }, 240); }); };
            box.appendChild(row);
          });
        });
      }, { cls: "tall", onClose: function () { hold = Math.max(0, hold - 1); } });
    }

    if (o.start != null) gi = o.start;
    showGroup(gi, o.startAt);
    return { close: close };
  }

  function loaderFor(id) {
    return NG.api("stories", { id: id }).then(function (r) { return r.ok ? { owner: r.data.owner, stories: r.data.stories } : null; });
  }

  /** Plays the stories of the given people one after another, starting at index `idx`. */
  NG.openStories = function (uids, idx) {
    if (!uids || !uids.length) return;
    openViewer(uids.map(function (id) { return { id: id, data: null }; }), idx || 0, { kind: "story", loader: loaderFor, onChange: function () { NG.emit("story:posted"); } });
  };

  NG.openHighlight = function (hid, owner, onChange) {
    NG.api("highlight", { hid: hid }).then(function (r) {
      if (!r.ok) return NG.toast(NG.errText(r));
      var d = r.data;
      openViewer([{ id: hid, data: { owner: d.owner, stories: d.stories, title: d.title } }], 0, { kind: "highlight", onChange: onChange });
    }).catch(NG.netErr);
  };

  /* ----------------------------------------------------------- create story */
  NG.createStory = function () {
    NG.pickImage(function (file) {
      NG.cropFlow(file, { ratios: [{ k: "9:16", r: 9 / 16 }], out: 1080, title: "استوری جدید", cta: "اشتراک", caption: 120, captionHint: "کپشن زیر استوری (اختیاری)", textOverlay: true }, function (res, done) {
        NG.api("story_create", { image: res.data, caption: res.caption }).then(function (r) {
          if (!r.ok) { done(false); return NG.toast(NG.errText(r)); }
          done(true); NG.haptic("ok"); NG.toast("✅ استوری گذاشته شد؛ ۲۴ ساعت دیده می‌شه");
          NG.refreshMe().then(function () { NG.emit("story:posted"); });
        }).catch(function () { done(false); NG.netErr(); });
      });
    });
  };

  /* ---------------------------------------------------------------- archive */
  function fmtDay(ms) { try { return new Date(ms).toLocaleDateString("fa-IR", { month: "short", day: "numeric" }); } catch (e) { return ""; } }

  NG.openArchive = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("آرشیو استوری‌ها"); w.appendChild(top);
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);
    w.appendChild(el('<div class="note">استوری‌ها ۲۴ ساعت نمایش داده می‌شن و ۳۰ روز توی آرشیو می‌مونن. برای ماندگاری، توی هایلایت بذارشون.</div>'));
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    NG.api("story_archive").then(function (r) {
      body.className = ""; body.innerHTML = "";
      if (!r.ok) return NG.toast(NG.errText(r));
      var items = r.data.items;
      if (!items.length) { body.innerHTML = NG.emptyHtml("archive", "آرشیو خالیه", "استوری‌هات اینجا ذخیره می‌شن."); return; }
      var grid = el('<div class="grid"></div>'); body.appendChild(grid);
      items.forEach(function (s, i) {
        var t = el('<div class="tile sk" style="aspect-ratio:9/14"></div>'); t.appendChild(NG.img(s.src));
        t.appendChild(el('<div class="cnt">' + fmtDay(s.at) + "</div>"));
        t.onclick = function () {
          // newest first in the grid; the viewer plays oldest -> newest like normal stories
          var list = items.slice().reverse();
          openViewer([{ id: "archive", data: { owner: NG.me, stories: list.map(function (x) { return Object.assign({}, x, { seen: true }); }) } }], 0, { kind: "archive", startAt: "first", onChange: function () { NG.openArchive.refresh && NG.openArchive.refresh(); } });
          void i;
        };
        grid.appendChild(t);
      });
    }).catch(NG.netErr);
  };

  /* ------------------------------------------------------- highlight editor */
  /** hid = null to create. preselect = story ids to start with. done() runs after a save / delete. */
  NG.openHighlightEditor = function (hid, done, preselect) {
    var w = el('<div style="min-height:100%;display:flex;flex-direction:column"></div>');
    var top = NG.topbar(hid ? "ویرایش هایلایت" : "هایلایت جدید", { right: "تأیید", rightClass: "done" });
    w.appendChild(top);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var done0 = top.querySelector(".done"); done0.disabled = true;
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);

    var state = { title: "", sel: [], cover: null, coverImage: null, origCover: null, stories: {}, ready: false };

    Promise.all([NG.api("story_archive"), hid ? NG.api("highlight", { hid: hid }) : Promise.resolve(null)]).then(function (res) {
      var ar = res[0], hr = res[1];
      if (!ar.ok || (hr && !hr.ok)) { NG.toast(NG.errText(ar.ok ? hr : ar)); return scr.close(); }
      ar.data.items.forEach(function (s) { state.stories[s.id] = s; });
      if (hr) {
        state.title = hr.data.title; state.sel = hr.data.stories.map(function (s) { return s.id; });
        hr.data.stories.forEach(function (s) { state.stories[s.id] = s; });
        state.cover = hr.data.coverStoryId; state.origCover = hr.data.coverStoryId; state.coverUrl = hr.data.coverMediaId ? hr.data.cover : null;
        state.hasCustom = !!hr.data.cover && !hr.data.coverStoryId;
      } else if (preselect) state.sel = preselect.slice();
      state.ready = true; build();
    }).catch(function () { NG.netErr(); scr.close(); });

    function sorted() { return Object.keys(state.stories).map(function (k) { return state.stories[k]; }).sort(function (a, b) { return b.at - a.at; }); }
    function valid() { return state.ready && state.title.trim().length >= 1 && state.sel.length >= 1; }

    function build() {
      body.className = ""; body.innerHTML = "";
      var prev = el('<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 0 6px"><div class="hc" id="pv" style="width:84px;height:84px;border-radius:50%;padding:4px;border:1px solid var(--sep)"><div class="i sk" style="width:100%;height:100%;border-radius:50%;overflow:hidden;background:var(--chip)"></div></div><button class="lnk" id="cc" style="color:var(--blue);font-weight:600;font-size:14px">تغییر کاور</button></div>');
      body.appendChild(prev);
      body.appendChild(el('<div style="padding:4px 16px 8px"><input class="inp" id="tt" maxlength="24" placeholder="نام هایلایت" value="' + esc(state.title) + '"></div>'));
      body.appendChild(el('<div class="hint">انتخاب استوری‌ها</div>'));
      var grid = el('<div class="grid"></div>'); body.appendChild(grid);
      var tt = body.querySelector("#tt");
      tt.oninput = function () { state.title = tt.value; upd(); };
      function paintCover() {
        var box = prev.querySelector(".i"); box.innerHTML = "";
        var src = null;
        if (state.coverImage) src = state.coverImage.data;
        else if (state.cover && state.stories[state.cover]) src = state.stories[state.cover].src;
        else if (state.coverUrl) src = state.coverUrl;
        else if (state.sel.length && state.stories[state.sel[0]]) src = state.stories[state.sel[0]].src;
        if (src) { box.classList.add("sk"); box.appendChild(NG.img(src, "cov")); box.firstChild.style.cssText = "width:100%;height:100%;object-fit:cover"; } else box.classList.remove("sk");
      }
      function upd() { done0.disabled = !valid(); paintCover(); }
      sorted().forEach(function (s) {
        var t = el('<div class="tile sk" style="aspect-ratio:9/13"></div>'); t.appendChild(NG.img(s.src));
        t.appendChild(el('<div class="cnt">' + fmtDay(s.at) + "</div>"));
        var ck = el('<div style="position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.25);color:#fff;transition:background .15s"></div>');
        t.appendChild(ck);
        function paint() { var on = state.sel.indexOf(s.id) >= 0; ck.style.background = on ? "var(--blue)" : "rgba(0,0,0,.25)"; ck.style.borderColor = on ? "var(--blue)" : "#fff"; ck.innerHTML = on ? svg("check", "") : ""; if (on) ck.firstChild.style.cssText = "width:13px;height:13px"; }
        paint();
        t.onclick = function () {
          var i = state.sel.indexOf(s.id);
          if (i >= 0) { state.sel.splice(i, 1); if (state.cover === s.id) state.cover = null; } else { if (state.sel.length >= 100) return NG.toast("حداکثر ۱۰۰ استوری."); state.sel.push(s.id); }
          NG.haptic("sel"); paint(); upd();
        };
        grid.appendChild(t);
      });
      if (!sorted().length) grid.outerHTML = NG.emptyHtml("archive", "استوری‌ای نداری", "اول یه استوری بذار تا بتونی هایلایت بسازی.");
      prev.querySelector("#cc").onclick = function () {
        var items = [];
        items.push({ label: "انتخاب از استوری‌های انتخاب‌شده", fn: function () { pickFromSelected(); } });
        items.push({ label: "آپلود عکس دلخواه", fn: function () { NG.pickImage(function (file) { NG.cropFlow(file, { ratios: [{ k: "1:1", r: 1 }], out: 600, title: "کاور هایلایت", cta: "تأیید", round: true }, function (res, d2) { state.coverImage = res; state.cover = null; d2(true); upd(); }); }); } });
        NG.actions(items);
      };
      function pickFromSelected() {
        if (!state.sel.length) return NG.toast("اول چند تا استوری انتخاب کن.");
        NG.sheet('<div class="shd">کاور رو انتخاب کن</div><div class="scroll"><div class="grid" id="cg"></div></div>', function (sh, close) {
          var g2 = sh.querySelector("#cg");
          state.sel.forEach(function (id) {
            var s = state.stories[id]; if (!s) return;
            var t = el('<div class="tile sk" style="aspect-ratio:9/13"></div>'); t.appendChild(NG.img(s.src));
            t.onclick = function () { state.cover = id; state.coverImage = null; state.coverUrl = null; close(); upd(); };
            g2.appendChild(t);
          });
        }, { cls: "tall" });
      }
      if (hid) {
        var del = el('<div style="padding:18px 16px"><button class="btn" style="width:100%;color:var(--red)">حذف هایلایت</button></div>');
        del.querySelector("button").onclick = function () {
          NG.confirm("حذف هایلایت؟", "فقط هایلایت پاک می‌شه؛ استوری‌ها در آرشیو می‌مونن.", "حذف", function () {
            NG.api("highlight_delete", { hid: hid }).then(function (r) { if (!r.ok) return NG.toast(NG.errText(r)); NG.haptic("ok"); NG.toast("هایلایت حذف شد"); scr.close(); if (done) done(); }).catch(NG.netErr);
          });
        };
        body.appendChild(del);
      }
      upd();
    }

    done0.onclick = function () {
      if (!valid()) return; done0.disabled = true;
      var b = { title: state.title.trim(), storyIds: state.sel };
      if (state.coverImage) b.coverImage = state.coverImage.data;
      else if (state.cover && (!hid || state.cover !== state.origCover)) b.coverStoryId = state.cover;
      if (hid) b.hid = hid;
      NG.api(hid ? "highlight_edit" : "highlight_create", b).then(function (r) {
        if (!r.ok) { done0.disabled = false; return NG.toast(NG.errText(r)); }
        NG.haptic("ok"); NG.toast(hid ? "هایلایت ذخیره شد ✓" : "هایلایت ساخته شد ✓"); scr.close(); if (done) done();
      }).catch(function () { done0.disabled = false; NG.netErr(); });
    };
  };
})();
