/* نوا گرام — activity (heart): live badge + pill on the home header, and the Activity screen
   (likes, follows, comments, replies). Everything shown here comes from the server; polling keeps it in sync. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num, svg = NG.svg;

  var last = { total: 0, likes: 0, follows: 0, comments: 0 };
  var btn = null, pill = null, first = true;

  /** Called with the `unread` object of every pulse. Animates only when something NEW arrived. */
  NG.setPulse = function (u) {
    u = u || last;
    var grew = !first && u.total > last.total;
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
    comment: "برای پست شما نظر گذاشت:",
    reply: "به نظر شما پاسخ داد:",
    like_comment: "نظر شما را پسندید:",
  };

  NG.openActivity = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("فعالیت");
    var body = el('<div class="acts"></div>');
    w.appendChild(top); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    var cursor = null, loading = false, marked = false;

    function followBtn(it, r) {
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
      var ring = NG.ring(it.actor, { noStory: true }); ring.style.width = "44px"; ring.style.height = "44px";
      r.querySelector(".nl").appendChild(ring);
      ring.onclick = function (e) { e.stopPropagation(); NG.openProfile(it.actor.id); };
      var nr = r.querySelector(".nr"), act = r.querySelector(".nact");

      if (it.type === "follow" || it.type === "accepted") nr.appendChild(followBtn(it, r));
      if (it.type === "follow_request") {
        if (it.pending) {
          var ok = el('<button class="fbtn">تأیید</button>'), no = el('<button class="fbtn gray">حذف</button>');
          var answer = function (accept, e) {
            e.stopPropagation(); ok.disabled = no.disabled = true;
            NG.api("follow_respond", { id: it.actor.id, accept: accept }).then(function (rr) {
              if (!rr.ok) { ok.disabled = no.disabled = false; return NG.toast(NG.errText(rr)); }
              NG.haptic("ok");
              if (accept) { it.type = "follow"; it.pending = false; it.iFollow = false; r.replaceWith(row(it)); } else r.remove();
              NG.emit("follow", { id: it.actor.id });
            }).catch(function () { ok.disabled = no.disabled = false; NG.netErr(); });
          };
          ok.onclick = function (e) { answer(true, e); }; no.onclick = function (e) { answer(false, e); };
          nr.appendChild(ok); nr.appendChild(no);
        } else nr.appendChild(followBtn(it, r));
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
        if (it.pid) NG.openPost(it.pid); else NG.openProfile(it.actor.id);
      };
      return r;
    }

    function load(reset) {
      if (loading) return; loading = true;
      if (reset) { body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>'; cursor = null; }
      NG.api("notifs", { before: cursor || undefined }).then(function (r) {
        loading = false;
        if (reset) body.innerHTML = "";
        var mb = body.querySelector(".moreb"); if (mb) mb.remove();
        if (!r.ok) return NG.toast(NG.errText(r));
        r.data.items.forEach(function (it) { body.appendChild(row(it)); });
        cursor = r.data.next;
        if (!body.children.length) body.innerHTML = NG.emptyHtml("heartO", "هنوز فعالیتی نیست", "وقتی کسی پستت رو بپسنده، دنبالت کنه یا نظر بذاره اینجا می‌بینی.");
        if (r.data.hasMore) { var b = el('<button class="moreb" style="width:100%;padding:14px;color:var(--blue);font-weight:600">بیشتر</button>'); b.onclick = function () { load(false); }; body.appendChild(b); }
        if (!marked) { marked = true; NG.api("notifs_seen").then(function () { NG.setPulse({ total: 0, likes: 0, follows: 0, comments: 0 }); }); } // the rows keep their "new" highlight until this screen is closed
      }).catch(function () { loading = false; NG.netErr(); });
    }
    load(true);
  };
})();
