/* نوا گرام — activity (heart): live badge + pill on the home header, and the Activity screen
   (likes, follows, comments, replies). Everything shown here comes from the server; polling keeps it in sync. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  var last = { latest: 0, total: 0, likes: 0, follows: 0, comments: 0 };
  var btn = null, pill = null, first = true;

  /** Called with the `unread` object of every pulse. Animates only when something NEW arrived. */
  NG.setPulse = function (u) {
    u = u || last;
    // Each notification animates ONCE per device: the newest one's time is remembered, so reopening the app after the activity
    // was seen (or after it already played) stays calm — only a newer notification plays the animation again.
    var stamp = u.latest || 0, shown = NG.ls.get("actAnim", 0), grew = stamp > shown;
    if (stamp > 0 && btn) { NG.ls.set("actAnim", Math.max(stamp, shown)); }
    last = u; first = false;
    if (!btn) return;
    btn.classList.toggle("has", u.total > 0);
    if (u.total > 0) {
      var parts = [];
      if (u.likes) parts.push('<span>' + svg("heartF", "") + "<b>" + num(u.likes) + "</b></span>");
      if (u.follows) parts.push('<span>' + svg("user", "") + "<b>" + num(u.follows) + "</b></span>");
      if (u.comments) parts.push('<span>' + svg("comment", "") + "<b>" + num(u.comments) + "</b></span>");
      pill.innerHTML = parts.join("");
      pill.classList.add("on");
    } else { pill.classList.remove("on"); pill.innerHTML = ""; }
    if (grew) {
      pill.classList.remove("bump"); void pill.offsetWidth; pill.classList.add("bump");
      btn.classList.remove("beat"); void btn.offsetWidth; btn.classList.add("beat");
      NG.haptic("sel");
    }
  };

  /** Wires the heart button + pill that renderHome put into the header. */
  NG.bindHeart = function (top) {
    btn = top.querySelector("#actb"); pill = top.querySelector("#actpill");
    if (!btn) return;
    btn.onclick = function () { NG.openActivity(); };
    pill.onclick = function () { NG.openActivity(); };
    NG.setPulse(last);
  };

  /* -------------------------------------------------------------- the screen */
  var VERB = {
    follow: "شما را دنبال کرد.",
    follow_request: "درخواست دنبال کردن شما را داد.",
    accepted: "درخواست دنبال کردنت را پذیرفت.",
    like_post: "پست شما را پسندید.",
    like_profile: "عکس پروفایل شما را پسندید.",
    story_like: "استوری شما را پسندید.",
    story_reply: "به استوری شما پاسخ داد:",
    comment: "برای پست شما نظر گذاشت:",
    reply: "به نظر شما پاسخ داد:",
    like_comment: "نظر شما را پسندید:"
  };
  /* Instagram-style stacked sections, in this order */
  var SECTIONS = [
    { id: "req", title: "درخواست‌های دنبال کردن", types: ["follow_request"], pendingOnly: true },
    { id: "fol", title: "دنبال‌کننده‌ها", types: ["follow", "accepted", "follow_request"] },
    { id: "lik", title: "پسندها", types: ["like_post", "like_profile", "story_like", "like_comment"] },
    { id: "com", title: "نظرها و پاسخ‌ها", types: ["comment", "reply", "story_reply"] }
  ];
  function sectionOf(it) {
    if (it.type === "follow_request" && it.pending) return "req";
    for (var i = 1; i < SECTIONS.length; i++) if (SECTIONS[i].types.indexOf(it.type) >= 0) return SECTIONS[i].id;
    return "fol";
  }

  NG.openActivity = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("فعالیت");
    var body = el('<div class="nlist"></div>');
    w.appendChild(top); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var cursor = null, loading = false, marked = false, secs = {}, more = null;

    function section(id) {
      if (secs[id]) return secs[id];
      var def = SECTIONS.filter(function (s) { return s.id === id; })[0];
      var box = el('<section class="nsec hide"><h4><span>' + esc(def.title) + '</span><i class="cnt"></i></h4><div class="nbody"></div></section>');
      secs[id] = { box: box, body: box.querySelector(".nbody"), cnt: box.querySelector(".cnt"), n: 0 };
      // keep the fixed order even when a later page brings a section that was empty before
      var idx = SECTIONS.indexOf(def), placed = false;
      for (var k = idx + 1; k < SECTIONS.length && !placed; k++) if (secs[SECTIONS[k].id]) { body.insertBefore(box, secs[SECTIONS[k].id].box); placed = true; }
      if (!placed) { if (more) body.insertBefore(box, more); else body.appendChild(box); }
      return secs[id];
    }
    function paintCount(s) { s.cnt.textContent = num(s.n); s.box.classList.toggle("hide", s.n === 0); }
    function drop(node, id) { var s = secs[id]; node.remove(); if (s) { s.n = Math.max(0, s.n - 1); paintCount(s); } }

    function followBtn(it) {
      var b = el('<button class="fbtn"></button>');
      function paint() {
        b.className = "fbtn" + (it.iFollow || it.requested ? " gray" : "");
        b.textContent = it.iFollow ? "دنبال می‌کنی" : it.requested ? "درخواست شده" : "دنبال کردن";
      }
      paint();
      b.onclick = function (e) {
        e.stopPropagation();
        var want = !(it.iFollow || it.requested); b.disabled = true;
        NG.api("follow", { id: it.actor.id, follow: want }).then(function (rr) {
          b.disabled = false;
          if (!rr.ok) return NG.toast(NG.errText(rr));
          it.iFollow = !!rr.data.following; it.requested = !!rr.data.requested; paint(); NG.haptic("sel"); NG.emit("follow", { id: it.actor.id });
        }).catch(function () { b.disabled = false; NG.netErr(); });
      };
      return b;
    }

    function row(it) {
      var verb = VERB[it.type] || "";
      var tail = it.text ? ' <span class="q">«' + esc(it.text) + "»</span>" : "";
      var r = el('<div class="nrow' + (it.seen ? "" : " new") + '"><div class="nl"></div><div class="nt"><div><b>' + esc(NG.nameOf(it.actor)) + NG.vb(it.actor) + "</b> " + esc(verb) + tail + ' <span class="ago">' + NG.ago(it.at) + '</span></div><div class="nact"></div></div><div class="nr"></div></div>');
      var ring = NG.ring(it.actor, { noStory: true });
      r.querySelector(".nl").appendChild(ring);
      ring.onclick = function (e) { e.stopPropagation(); NG.openProfile(it.actor.id); };
      var nr = r.querySelector(".nr"), act = r.querySelector(".nact");

      if (it.type === "follow" || it.type === "accepted") nr.appendChild(followBtn(it));
      if (it.type === "follow_request") {
        if (it.pending) {
          var ok = el('<button class="fbtn">تأیید</button>'), no = el('<button class="fbtn gray">حذف</button>');
          var answer = function (accept, e) {
            e.stopPropagation(); ok.disabled = no.disabled = true;
            NG.api("follow_respond", { id: it.actor.id, accept: accept }).then(function (rr) {
              if (!rr.ok) { ok.disabled = no.disabled = false; return NG.toast(NG.errText(rr)); }
              NG.haptic("ok");
              drop(r, "req");
              if (accept) { it.type = "follow"; it.pending = false; it.iFollow = false; var s2 = section("fol"); s2.body.insertBefore(row(it), s2.body.firstChild); s2.n++; paintCount(s2); }
              NG.emit("follow", { id: it.actor.id });
            }).catch(function () { ok.disabled = no.disabled = false; NG.netErr(); });
          };
          ok.onclick = function (e) { answer(true, e); }; no.onclick = function (e) { answer(false, e); };
          nr.appendChild(ok); nr.appendChild(no);
        } else nr.appendChild(followBtn(it));
      }
      if (it.src) { var th = el('<div class="thumb sk"></div>'); th.appendChild(NG.img(it.src)); nr.appendChild(th); }
      else if (it.type === "like_profile" && NG.me && NG.me.av) { var th2 = el('<div class="thumb sk"></div>'); th2.appendChild(NG.img(NG.me.av)); nr.appendChild(th2); }

      if ((it.type === "comment" || it.type === "reply") && it.commentId && it.pid) {
        var rp = el('<button class="nbtn">پاسخ</button>');
        var lk = el('<button class="nbtn lk' + (it.liked ? " on" : "") + '">' + (it.liked ? "♥ پسندیده" : "♡ پسندیدن") + "</button>");
        rp.onclick = function (e) {
          e.stopPropagation();
          NG.api("post", { pid: it.pid }).then(function (rr) {
            if (!rr.ok) return NG.toast(NG.errText(rr));
            NG.openComments(NG.upsert(rr.data.item), { replyTo: { id: it.commentId, name: NG.nameOf(it.actor) } });
          }).catch(NG.netErr);
        };
        lk.onclick = function (e) {
          e.stopPropagation();
          var want = !it.liked; lk.disabled = true;
          NG.api("comment_like", { commentId: it.commentId, like: want }).then(function (rr) {
            lk.disabled = false;
            if (!rr.ok) return NG.toast(NG.errText(rr));
            it.liked = rr.data.liked; lk.classList.toggle("on", it.liked); lk.textContent = it.liked ? "♥ پسندیده" : "♡ پسندیدن"; NG.haptic("sel");
          }).catch(function () { lk.disabled = false; NG.netErr(); });
        };
        act.appendChild(rp); act.appendChild(lk);
      }
      r.onclick = function () {
        if (it.type === "story_like" || it.type === "story_reply") { if (NG.me) NG.openStories([NG.me.id], 0); return; }
        if (it.pid) NG.openPost(it.pid); else NG.openProfile(it.actor.id);
      };
      return r;
    }

    function load(reset) {
      if (loading) return; loading = true;
      if (reset) { body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>'; cursor = null; secs = {}; more = null; }
      NG.api("notifs", { before: cursor || undefined }).then(function (r) {
        loading = false;
        if (reset) body.innerHTML = "";
        if (more) { more.remove(); more = null; }
        if (!r.ok) return NG.toast(NG.errText(r));
        r.data.items.forEach(function (it) { var s = section(sectionOf(it)); s.body.appendChild(row(it)); s.n++; });
        Object.keys(secs).forEach(function (k) { paintCount(secs[k]); });
        cursor = r.data.next;
        if (!Object.keys(secs).length) body.innerHTML = NG.emptyHtml("heartO", "هنوز فعالیتی نیست", "وقتی کسی پستت رو بپسنده، دنبالت کنه یا نظر بذاره اینجا می‌بینی.");
        if (r.data.hasMore) { more = el('<button class="moreb">بیشتر</button>'); more.onclick = function () { load(false); }; body.appendChild(more); }
        if (!marked) { marked = true; NG.ls.set("actAnim", Date.now() + (NG.skew || 0) + 60000); NG.api("notifs_seen").then(function () { NG.setPulse({ total: 0, likes: 0, follows: 0, comments: 0 }); }); } // the rows keep their "new" highlight until this screen is closed
      }).catch(function () { loading = false; NG.netErr(); });
    }
    load(true);
  };
})();
