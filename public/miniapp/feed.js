/* مویاگرام — feed: post card, likes, comments, post viewer, home (stories tray + posts). */
(function () {
  "use strict";
  var NG = window.NG, $ = NG.$, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  /* ------------------------------------------------ shared post objects */
  var items = (NG.items = {});
  /** One object per post id, shared by every screen that shows it. */
  NG.upsert = function (it) {
    var cur = items[it.pid];
    if (cur) { Object.assign(cur, it); return cur; }
    items[it.pid] = it; return it;
  };

  function likesText(it) {
    if (it.hideLikes && !it.mine) return "تعداد لایک‌ها مخفی شده";
    if (!it.likes) return "اولین نفری باش که لایک می‌کنه";
    return num(it.likes) + " لایک" + (it.hideLikes && it.mine ? " (برای بقیه مخفیه)" : "");
  }
  function commentsLink(it) { return it.comments ? "مشاهده‌ی همه‌ی " + num(it.comments) + " نظر" : ""; }

  /** Re-draws the live parts (heart, like text, comment count) of every copy of a post on screen. */
  NG.syncPost = function (it) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pid="' + it.pid + '"]'), function (p) {
      var b = p.querySelector(".like"); if (!b) return;
      b.classList.toggle("on", !!it.liked); b.innerHTML = svg(it.liked ? "heartF" : "heartO");
      var lk = p.querySelector(".likes"); if (lk) lk.textContent = likesText(it);
      var va = p.querySelector(".viewall"); if (va) { va.textContent = commentsLink(it); va.classList.toggle("hide", !it.comments); }
      var ad = p.querySelector(".addc"); if (ad) ad.classList.toggle("hide", !!it.noComments);
    });
  };

  function doLike(it, want) {
    var prev = { liked: it.liked, likes: it.likes };
    it.liked = want; it.likes = Math.max(0, it.likes + (want ? 1 : -1)); NG.syncPost(it); NG.haptic();
    NG.api("like", { pid: it.pid, like: want }).then(function (r) {
      if (r.ok) { it.liked = r.data.liked; if (!(it.hideLikes && !it.mine)) it.likes = r.data.likes; NG.syncPost(it); }
      else { it.liked = prev.liked; it.likes = prev.likes; NG.syncPost(it); NG.toast(NG.errText(r, "لایک ثبت نشد.")); }
    }).catch(function () { it.liked = prev.liked; it.likes = prev.likes; NG.syncPost(it); NG.netErr(); });
  }
  NG.doLike = doLike;

  /* --------------------------------------------------------------- card */
  function capHtml(it, full) {
    var c = it.caption || "";
    if (!c) return "";
    var long = !full && c.length > 110;
    return '<div class="cap"><b>' + esc(NG.nameOf(it.owner)) + '</b><span class="t">' + esc(long ? c.slice(0, 110) + "…" : c) + "</span>" + (long ? ' <span class="more">بیشتر</span>' : "") + "</div>";
  }

  NG.postEl = function (it, opts) {
    opts = opts || {};
    var p = el('<article class="post" data-pid="' + esc(it.pid) + '"></article>');
    var head = el('<div class="ph"></div>');
    var ring = NG.ring(it.owner);
    var who = el('<div class="who"><div class="un">' + esc(NG.nameOf(it.owner)) + NG.vb(it.owner) + "</div>" + (it.kind === "profile" ? '<div class="sub">عکس پروفایل</div>' : "") + "</div>");
    var more = el('<button class="more" aria-label="more">' + svg("dots") + "</button>");
    head.appendChild(ring); head.appendChild(who); head.appendChild(more);
    ring.style.cursor = "pointer";
    ring.onclick = function () {
      if (it.owner.story && NG.openStories) NG.openStories([it.owner.id], 0); else NG.openProfile(it.owner.id);
    };
    who.onclick = function () { NG.openProfile(it.owner.id); };
    more.onclick = function () { postMenu(it); };
    p.appendChild(head);

    var media = el('<div class="media sk" style="aspect-ratio:' + (it.ar || 0.8) + '"><div class="bigheart">' + svg("heartF", "") + "</div></div>");
    media.insertBefore(NG.img(it.src), media.firstChild);
    var last = 0;
    media.addEventListener("click", function () {
      var now = Date.now();
      if (now - last < 320) {
        last = 0;
        var bh = media.querySelector(".bigheart"); bh.classList.remove("go"); void bh.offsetWidth; bh.classList.add("go");
        if (!it.liked) doLike(it, true); else NG.haptic();
      } else last = now;
    });
    p.appendChild(media);

    var acts = el('<div class="acts"><button class="like' + (it.liked ? " on" : "") + '" aria-label="like">' + svg(it.liked ? "heartF" : "heartO") + '</button><button class="cm" aria-label="comments">' + svg("comment") + '</button><button class="sh" aria-label="share">' + svg("plane") + '</button><span class="sp"></span>' + (it.mine ? "" : '<button class="gf" aria-label="gift">' + svg("gift") + "</button>") + "</div>");
    acts.querySelector(".like").onclick = function () { doLike(it, !it.liked); };
    acts.querySelector(".cm").onclick = function () { NG.openComments(it); };
    acts.querySelector(".sh").onclick = function () { NG.share("pid", it.pid); };
    var gf = acts.querySelector(".gf"); if (gf) gf.onclick = function () { NG.openGiftSheet(it.owner); };
    p.appendChild(acts);
    p.appendChild(el('<div class="likes">' + likesText(it) + "</div>"));
    var cap = el(capHtml(it, opts.full) || "<span></span>");
    p.appendChild(cap);
    var mo = cap.querySelector && cap.querySelector(".more");
    if (mo) mo.onclick = function () { cap.querySelector(".t").textContent = it.caption; mo.remove(); };
    var cb = cap.querySelector && cap.querySelector("b"); if (cb) cb.onclick = function () { NG.openProfile(it.owner.id); };
    var va = el('<div class="viewall' + (it.comments ? "" : " hide") + '">' + commentsLink(it) + "</div>");
    va.onclick = function () { NG.openComments(it); };
    p.appendChild(va);
    var ad = el('<div class="addc' + (it.noComments ? " hide" : "") + '"><div class="mini"></div><span>افزودن نظر…</span></div>');
    if (NG.me && NG.me.av) ad.querySelector(".mini").appendChild(NG.img(NG.me.av, "cov"));
    ad.onclick = function () { NG.openComments(it); };
    p.appendChild(ad);
    p.appendChild(el('<div class="meta">' + NG.ago(it.at) + "</div>"));
    return p;
  };

  /* --------------------------------------------------------- post menu */
  function postMenu(it) {
    var list = [];
    if (it.mine && it.kind === "post") {
      list.push({ label: "ویرایش کپشن", fn: function () { editCaption(it); } });
      list.push({ label: it.noComments ? "روشن کردن نظرات" : "خاموش کردن نظرات", fn: function () { setFlag(it, "noComments", !it.noComments); } });
      list.push({ label: it.hideLikes ? "نمایش تعداد لایک‌ها" : "مخفی کردن تعداد لایک‌ها", fn: function () { setFlag(it, "hideLikes", !it.hideLikes); } });
    }
    if (it.mine && it.kind === "profile") list.push({ label: "تغییر عکس پروفایل", fn: function () { NG.changeProfilePhoto(); } });
    list.push({ label: "اشتراک‌گذاری", fn: function () { NG.share("pid", it.pid); } });
    if (!it.mine) {
      list.push({ label: "ارسال هدیه", fn: function () { NG.openGiftSheet(it.owner); } });
      list.push({ label: "درخواست چت ناشناس", fn: function () { NG.requestChat(it.owner); } });
    }
    list.push({ label: "رفتن به پروفایل", fn: function () { NG.openProfile(it.owner.id); } });
    if (!it.mine && it.kind === "post") list.push({ label: "گزارش پست", cls: "red", fn: function () { reportPost(it); } });
    if (NG.staff && !it.mine) list.push({ label: it.kind === "post" ? "حذف پست (مدیریت)" : "حذف عکس پروفایل (مدیریت)", cls: "red", fn: function () { staffRemove(it); } });
    if (it.mine && it.kind === "post") list.push({ label: "حذف پست", cls: "red", fn: function () { NG.confirm("حذف پست؟", "این پست همراه با لایک‌ها و نظرهاش برای همیشه پاک می‌شه.", "حذف", function () { deletePost(it); }); } });
    NG.actions(list);
  }
  var REPORT_REASONS = [{ k: "nudity", l: "محتوای مستهجن" }, { k: "spam", l: "اسپم / تبلیغ" }, { k: "abuse", l: "توهین / آزار" }, { k: "other", l: "سایر" }];
  function reportPost(it) {
    NG.actions(REPORT_REASONS.map(function (x) {
      return { label: x.l, fn: function () {
        NG.api("post_report", { pid: it.pid, reason: x.k }).then(function (r) {
          if (!r.ok) return NG.toast(NG.errText(r));
          NG.haptic("ok"); NG.toast(r.data.status === "duplicate" ? "قبلاً این پست رو گزارش کردی." : "✅ گزارش ثبت شد؛ مدیریت بررسی می‌کنه.");
        }).catch(NG.netErr);
      } };
    }), "دلیل گزارش");
  }
  function setFlag(it, key, val) {
    var b = { pid: it.pid }; b[key] = val;
    NG.api("post_edit", b).then(function (r) {
      if (!r.ok) return NG.toast(NG.errText(r));
      it.noComments = r.data.noComments; it.hideLikes = r.data.hideLikes; it.caption = r.data.caption;
      NG.syncPost(it); NG.toast("ذخیره شد ✓"); NG.haptic("ok");
    }).catch(NG.netErr);
  }
  /** owner / admins: remove somebody's photo from Home / Explore; the person gets a message from Nava (a read-only direct thread) */
  function staffRemove(it) {
    NG.sheet('<div class="shd">حذف توسط مدیریت</div><div class="ctx">این مورد برای همیشه حذف می‌شه و از طرف مویا یک پیام به صاحبش در بخش پیام‌ها می‌رسه. دلیل (اختیاری):</div><div class="pad"><input class="inp" id="why" maxlength="200" placeholder="مثلاً: نقض قوانین"></div><div class="pad" style="margin-top:10px"><button class="btn tall" id="go" style="width:100%;background:var(--red);color:#fff">حذف و ارسال پیام</button></div>', function (sh, close) {
      sh.querySelector("#go").onclick = function () {
        var why = sh.querySelector("#why").value.trim();
        close(function () {
          if (it.kind === "post") return deletePost(it, why);
          NG.api("mod", { id: it.owner.id, op: "photo_remove", reason: why }).then(function (r) {
            if (!r.ok) return NG.toast(NG.errText(r));
            NG.haptic("ok"); NG.toast("عکس حذف شد"); delete items[it.pid]; NG.emit("post:deleted", it.pid);
          }).catch(NG.netErr);
        });
      };
    });
  }
  function deletePost(it, why) {
    NG.api("post_delete", { pid: it.pid, reason: why || undefined }).then(function (r) {
      if (!r.ok) return NG.toast(NG.errText(r));
      NG.haptic("ok"); NG.toast("پست حذف شد");
      delete items[it.pid];
      NG.emit("post:deleted", it.pid);
    }).catch(NG.netErr);
  }
  NG.on("post:deleted", function (pid) {
    Array.prototype.forEach.call(document.querySelectorAll('.post[data-pid="' + pid + '"]'), function (p) { var s = p.closest(".slot"); (s || p).remove(); });
  });
  function editCaption(it) {
    var w = el('<div style="min-height:100%;display:flex;flex-direction:column"></div>');
    var top = NG.topbar("ویرایش کپشن", { right: "تأیید", rightClass: "done" });
    var cmp = el('<div class="cmp"><div class="th sk"></div><textarea maxlength="1000" placeholder="کپشن…"></textarea></div>');
    cmp.querySelector(".th").appendChild(NG.img(it.src, "cov"));
    var ta = cmp.querySelector("textarea"); ta.value = it.caption || "";
    var cnt = el('<div class="cmp-cnt"></div>');
    function upd() { cnt.textContent = ta.value.length + " / 1000"; }
    ta.oninput = upd; upd();
    w.appendChild(top); w.appendChild(cmp); w.appendChild(cnt);
    var scr = NG.push(w);
    top.querySelector(".bk").onclick = scr.close;
    var done = top.querySelector(".done");
    done.onclick = function () {
      done.disabled = true;
      NG.api("post_edit", { pid: it.pid, caption: ta.value }).then(function (r) {
        if (!r.ok) { done.disabled = false; return NG.toast(NG.errText(r)); }
        it.caption = r.data.caption; NG.haptic("ok"); scr.close();
        Array.prototype.forEach.call(document.querySelectorAll('.post[data-pid="' + it.pid + '"]'), function (p) {
          var old = p.querySelector(".cap"); var n = el(capHtml(it, true) || "<span></span>");
          if (old) old.replaceWith(n); else p.querySelector(".likes").after(n);
        });
        NG.toast("ذخیره شد ✓");
      }).catch(function () { done.disabled = false; NG.netErr(); });
    };
  }

  /* ----------------------------------------------------------- comments */
  NG.openComments = function (it, opt) {
    opt = opt || {};
    var draftKey = "draft.c." + it.pid;
    NG.sheet('<div class="shd">نظرات</div><div class="scroll" id="cl"></div><div id="cin"></div>', function (sh, close) {
      var list = sh.querySelector("#cl"), foot = sh.querySelector("#cin");
      var oldest = null, more = false, loading = false, replyTo = null, setReply = null;
      function row(c, fresh) {
        var r = el('<div class="cm' + (fresh ? " new" : "") + '" data-cid="' + esc(c.id) + '"><div class="mini sk"></div><div class="b"><div><b>' + esc(NG.nameOf(c.user)) + NG.vb(c.user) + '</b>' + (c.replyTo ? '<span class="rto">↪ ' + esc(c.replyTo.name) + "</span>" : "") + '<span class="tx">' + esc(c.text) + '</span></div><div class="tm"><span>' + NG.ago(c.at) + "</span>" + (it.noComments ? "" : '<button class="rp">پاسخ</button>') + (c.canDelete ? '<button class="del">حذف</button>' : "") + '</div></div><button class="clk' + (c.liked ? " on" : "") + '" aria-label="like">' + svg(c.liked ? "heartF" : "heartO", "") + '<i>' + (c.likes ? NG.num(c.likes) : "") + "</i></button></div>");
        var lk = r.querySelector(".clk");
        lk.onclick = function () {
          var want = !lk.classList.contains("on");
          function paint(on, n) { lk.classList.toggle("on", on); lk.innerHTML = svg(on ? "heartF" : "heartO", "") + "<i>" + (n ? NG.num(n) : "") + "</i>"; }
          paint(want, Math.max(0, (c.likes || 0) + (want ? 1 : -1))); NG.haptic("sel");
          NG.api("comment_like", { commentId: c.id, like: want }).then(function (rr) {
            if (!rr.ok) { paint(!want, c.likes || 0); return NG.toast(NG.errText(rr)); }
            c.liked = rr.data.liked; c.likes = rr.data.likes; paint(c.liked, c.likes);
          }).catch(function () { paint(!want, c.likes || 0); NG.netErr(); });
        };
        var rp = r.querySelector(".rp");
        if (rp) rp.onclick = function () { if (setReply) setReply({ id: c.id, name: NG.nameOf(c.user) }); };
        if (c.user.av) r.querySelector(".mini").appendChild(NG.img(c.user.av)); else { r.querySelector(".mini").classList.remove("sk"); r.querySelector(".mini").innerHTML = svg("user", "ico"); }
        var go = function () { close(function () { NG.openProfile(c.user.id); }); };
        r.querySelector(".mini").onclick = go; r.querySelector("b").onclick = go;
        var del = r.querySelector(".del");
        if (del) del.onclick = function () {
          NG.confirm("حذف نظر؟", "این نظر پاک می‌شه.", "حذف", function () {
            NG.api("comment_delete", { commentId: c.id }).then(function (rr) {
              if (!rr.ok) return NG.toast(NG.errText(rr));
              r.remove(); it.comments = rr.data.comments; NG.syncPost(it); NG.haptic("ok");
              if (!list.querySelector(".cm")) list.innerHTML = '<div class="empty" style="padding:40px 20px">هنوز نظری نیست.</div>';
            }).catch(NG.netErr);
          });
        };
        return r;
      }
      function load() {
        if (loading) return; loading = true;
        var btn = list.querySelector(".moreb"); if (btn) btn.remove();
        NG.api("comments", { pid: it.pid, before: oldest || undefined }).then(function (r) {
          loading = false;
          if (!r.ok) return NG.toast(NG.errText(r));
          var sp = list.querySelector(".lsp"); if (sp) sp.remove();
          r.data.items.forEach(function (c) { list.appendChild(row(c)); oldest = c.at; });
          more = r.data.hasMore;
          if (!list.querySelector(".cm")) list.innerHTML = '<div class="empty" style="padding:40px 20px"><h3 style="font-size:18px">هنوز نظری نیست</h3>اولین نفری باش که نظر می‌ده.</div>';
          if (more) { var b = el('<button class="moreb" style="width:100%;padding:14px;color:var(--blue);font-weight:600">نظرهای بیشتر</button>'); b.onclick = load; list.appendChild(b); }
        }).catch(function () { loading = false; NG.netErr(); });
      }
      list.innerHTML = '<div class="more-spin lsp"><div class="spin"></div></div>';
      load();

      if (it.noComments) { foot.innerHTML = '<div class="cinput off">نظرها برای این پست بسته شده.</div>'; return; }
      foot.innerHTML = '<div class="cinput"><div class="mini sk"></div><div class="f"><input type="text" maxlength="500" placeholder="افزودن نظر برای ' + esc(NG.nameOf(it.owner)) + '…" enterkeyhint="send"><button class="send">ارسال</button></div></div>';
      var mi = foot.querySelector(".mini");
      if (NG.me && NG.me.av) mi.appendChild(NG.img(NG.me.av)); else { mi.classList.remove("sk"); }
      var inp = foot.querySelector("input"), send = foot.querySelector(".send"), sending = false;
      var bar = el('<div class="rpbar" style="display:none"><span></span><button aria-label="cancel">✕</button></div>');
      foot.insertBefore(bar, foot.firstChild);
      var basePh = inp.placeholder;
      setReply = function (rt) {
        replyTo = rt; bar.style.display = rt ? "flex" : "none";
        if (rt) { bar.querySelector("span").textContent = "در حال پاسخ به " + rt.name; inp.placeholder = "پاسخ به " + rt.name + "…"; inp.focus(); } else inp.placeholder = basePh;
      };
      bar.querySelector("button").onclick = function () { setReply(null); };
      if (opt.replyTo) setReply(opt.replyTo);
      inp.value = NG.ls.get(draftKey, "") || "";
      function ready() { send.classList.toggle("on", !!inp.value.trim()); }
      ready();
      inp.oninput = function () { ready(); NG.ls.set(draftKey, inp.value); };
      function submit() {
        var t = inp.value.trim(); if (!t || sending) return;
        sending = true; send.classList.remove("on");
        NG.api("comment_add", { pid: it.pid, text: t, replyTo: replyTo ? replyTo.id : undefined }).then(function (r) {
          sending = false;
          if (!r.ok) { ready(); return NG.toast(NG.errText(r)); }
          inp.value = ""; NG.ls.del(draftKey); ready(); NG.haptic("ok"); setReply(null);
          var emp = list.querySelector(".empty"); if (emp) emp.remove();
          list.insertBefore(row(r.data.comment, true), list.firstChild);
          list.scrollTop = 0;
          it.comments = r.data.comments; NG.syncPost(it);
        }).catch(function () { sending = false; ready(); NG.netErr(); });
      }
      send.onclick = submit;
      inp.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    }, { cls: "tall" });
  };

  /* -------------------------------------------------------- post viewer */
  /** Vertical list of posts (like Instagram's "Posts" screen). pids = ids in order, start = index to scroll to. */
  NG.openPosts = function (pids, start, title) {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar(title || "پست‌ها");
    w.appendChild(top);
    var body = el("<div></div>"); w.appendChild(body);
    var scr = NG.push(w);
    top.querySelector(".bk").onclick = scr.close;
    var io = "IntersectionObserver" in window ? new IntersectionObserver(function (en) {
      en.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); fill(e.target); } });
    }, { root: scr.el, rootMargin: "700px 0px" }) : null;
    function fill(slot) {
      var pid = slot.getAttribute("data-slot");
      var have = items[pid];
      var show = function (it) { slot.classList.remove("slot", "sk"); slot.innerHTML = ""; slot.style.minHeight = ""; slot.appendChild(NG.postEl(it, { full: true })); };
      if (have && have.owner) return show(have);
      NG.api("post", { pid: pid }).then(function (r) {
        if (!r.ok) { slot.remove(); return; }
        show(NG.upsert(r.data.item));
      }).catch(function () { slot.innerHTML = '<div class="empty" style="padding:40px">اتصال برقرار نیست.</div>'; });
    }
    pids.forEach(function (pid, i) {
      var s = el('<div class="slot sk" data-slot="' + esc(pid) + '"></div>');
      body.appendChild(s);
      if (Math.abs(i - start) <= 1 || !io) fill(s); else io.observe(s);
    });
    var target = body.children[start];
    if (target) setTimeout(function () { scr.el.scrollTop = target.offsetTop - 50; }, 30);
    var off = function (pid) { var s = body.querySelector('[data-slot="' + pid + '"]'); if (s) s.remove(); if (!body.children.length) scr.close(); };
    NG.on("post:deleted", off);
    return scr;
  };
  NG.openPost = function (pid) { return NG.openPosts([pid], 0, "پست"); };

  /* -------------------------------------------------------------- home */
  var feed = { items: [], more: true, loading: false, cursor: null };
  var tray = [];
  var pgHome;

  function trayHtmlSkeleton() { return '<div class="stories-sk"><i class="sk"></i><i class="sk"></i><i class="sk"></i><i class="sk"></i><i class="sk"></i></div>'; }
  function renderTray() {
    var st = $("tray"); if (!st) return; st.innerHTML = "";
    var m = NG.me, hasMine = m && m.story > 0;
    var mine = el('<button class="story"><div class="ring ' + (hasMine ? "" : "none") + '" data-fixed="1" data-uid="' + esc(m.id) + '"><div class="in"></div><div class="plus"><svg viewBox="0 0 24 24">' + NG.P.plusS + '</svg></div></div><div class="nm">استوری شما</div></button>');
    var inn = mine.querySelector(".in");
    if (m.av) { inn.classList.add("sk"); inn.appendChild(NG.img(m.av)); } else inn.innerHTML = svg("user", "");
    mine.querySelector(".plus").onclick = function (e) { e.stopPropagation(); NG.createStory(); };
    mine.onclick = function () { if (hasMine) NG.openStories([m.id], 0); else NG.createStory(); };
    st.appendChild(mine);
    // like Instagram: people you have fully watched (grey ring) move to the end; unseen ones stay first (stable order otherwise)
    var ordered = tray.map(function (b, i) { return { b: b, i: i }; }).sort(function (x, y) { var xs = x.b.story === 1 ? 1 : 0, ys = y.b.story === 1 ? 1 : 0; return xs - ys || x.i - y.i; }).map(function (x) { return x.b; });
    var ids = ordered.filter(function (b) { return b.id !== m.id; }).map(function (b) { return b.id; });
    ordered.forEach(function (b) {
      if (b.id === m.id) return;
      var s = el('<button class="story"><div class="nm' + (b.story === 1 ? " old" : "") + '">' + esc(NG.nameOf(b)) + "</div></button>");
      var r = NG.ring(b); s.insertBefore(r, s.firstChild);
      s.onclick = function () { NG.openStories(ids, ids.indexOf(b.id)); };
      st.appendChild(s);
    });
  }
  NG.refreshTray = function () {
    return NG.api("home", { before: undefined }).then(function (r) { if (r.ok && r.data.tray) { tray = r.data.tray; renderTray(); } });
  };
  NG.on("story:seen", function (d) {
    tray.forEach(function (b) { if (b.id === d.uid) b.story = d.state; });
    NG.setUserStory(d.uid, d.state);
    if (d.state === 1) setTimeout(renderTray, 320); // re-sort once the viewer slid away
  });
  NG.on("story:posted", function () { NG.refresh(); NG.refreshTray(); });

  function skeletonPosts(n) {
    var h = "";
    for (var i = 0; i < n; i++) h += '<div class="post"><div class="ph"><div class="ring none"><div class="in sk"></div></div><div class="who"><div class="sk" style="height:10px;width:90px;border-radius:5px"></div></div></div><div class="media sk" style="aspect-ratio:.8"></div></div>';
    return h;
  }

  function addItems(list, prepend) {
    var box = $("feedlist"); if (!box) return;
    var frag = document.createDocumentFragment(), fresh = [];
    list.forEach(function (raw) {
      var it = NG.upsert(raw);
      if (feed.items.some(function (x) { return x.pid === it.pid; })) return;
      fresh.push(it);
    });
    fresh.forEach(function (it) { frag.appendChild(NG.postEl(it)); });
    if (prepend) { feed.items = fresh.concat(feed.items); box.insertBefore(frag, box.firstChild); }
    else { feed.items = feed.items.concat(fresh); box.appendChild(frag); }
  }
  NG.on("post:deleted", function (pid) { feed.items = feed.items.filter(function (x) { return x.pid !== pid; }); });
  NG.on("post:created", function (it) { if (pgHome && $("feedlist")) { var e = $("feedlist").querySelector(".empty"); if (e) e.remove(); addItems([it], true); } });

  function loadFeed(first) {
    if (feed.loading || (!feed.more && !first)) return;
    feed.loading = true;
    var spin = $("feedspin"); if (spin && !first) spin.classList.remove("hide");
    return NG.api("home", { before: first ? undefined : feed.cursor }).then(function (r) {
      feed.loading = false; if (spin) spin.classList.add("hide");
      if (!r.ok) return NG.fail(r);
      if (first) {
        $("feedlist").innerHTML = ""; feed.items = [];
        tray = r.data.tray || []; renderTray();
        NG.ls.set("home", { items: r.data.items, tray: tray, t: Date.now() });
      }
      addItems(r.data.items);
      feed.more = r.data.hasMore;
      if (r.data.items.length) feed.cursor = r.data.items[r.data.items.length - 1].at;
      if (!feed.items.length) $("feedlist").innerHTML = NG.emptyHtml("camera", "هنوز پستی نیست", "به‌محض این‌که کاربرها عکس بذارن اینجا می‌بینی‌شون.");
    }).catch(function () { feed.loading = false; if (spin) spin.classList.add("hide"); if (first && !feed.items.length) $("feedlist").innerHTML = ""; NG.netErr(); });
  }

  /** Reloads the home feed from the top (pull to refresh, tapping Home twice, after posting). */
  NG.refresh = function () { feed.more = true; feed.cursor = null; return loadFeed(true); };

  NG.renderHome = function (page) {
    pgHome = page; page.innerHTML = "";
    var top = el('<div class="topbar"><div class="wordmark en">Moyagram</div><div class="icons"><div class="actwrap"><button id="actb" aria-label="activity">' + svg("heartO") + '<i class="dot"></i></button><div class="actpill" id="actpill"></div></div><button id="addp" aria-label="new post">' + svg("plus") + "</button></div></div>");
    top.querySelector("#addp").onclick = function () { NG.composeMenu(); };
    if (NG.bindHeart) NG.bindHeart(top);
    page.appendChild(top);
    page.appendChild(el('<div class="stories" id="tray">' + trayHtmlSkeleton() + "</div>"));
    var ptr = el('<div class="more-spin hide" id="ptr" style="padding:10px"><div class="spin"></div></div>');
    page.appendChild(ptr);
    var list = el('<div id="feedlist"></div>'); page.appendChild(list);
    page.appendChild(el('<div class="more-spin hide" id="feedspin"><div class="spin"></div></div>'));
    page.appendChild(el('<div id="feedend" style="height:2px"></div>'));

    // instant paint from the last visit, then refresh in the background
    var cache = NG.ls.get("home", null);
    if (cache && cache.items && cache.items.length) {
      tray = cache.tray || []; renderTray(); addItems(cache.items);
      if (cache.items.length) feed.cursor = cache.items[cache.items.length - 1].at;
    } else list.innerHTML = skeletonPosts(2);
    if ("IntersectionObserver" in window) new IntersectionObserver(function (en) { if (en[0].isIntersecting && feed.items.length) loadFeed(false); }, { root: page, rootMargin: "700px 0px" }).observe($("feedend"));

    // pull to refresh
    var y0 = null, dy = 0;
    page.addEventListener("touchstart", function (e) { y0 = page.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
    page.addEventListener("touchmove", function (e) {
      if (y0 == null) return; dy = e.touches[0].clientY - y0;
      if (dy > 8) { ptr.classList.remove("hide"); ptr.style.height = Math.min(dy, 90) * 0.6 + "px"; ptr.style.opacity = Math.min(1, dy / 90); }
    }, { passive: true });
    page.addEventListener("touchend", function () {
      if (y0 == null) return;
      var go = dy > 90; y0 = null;
      ptr.style.height = ""; ptr.style.opacity = "";
      if (go) { NG.haptic("sel"); NG.refresh().then(function () { ptr.classList.add("hide"); }); } else ptr.classList.add("hide");
    }, { passive: true });
    return loadFeed(true);
  };
})();
