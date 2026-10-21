/* نوا گرام — safety + staff tools: block / unblock / report (synced with the bot), blocked list, and the owner/admin moderation menu on a profile. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num;

  var REASONS = [["spam", "اسپم یا تبلیغ"], ["fake", "حساب جعلی / جعل هویت"], ["nudity", "محتوای نامناسب یا برهنگی"], ["abuse", "توهین، تهدید یا آزار"], ["scam", "کلاهبرداری"], ["other", "دلیل دیگر"]];

  /** Reads an image file, shrinks it and returns a JPEG data URL (≤ ~2.5 MB). */
  NG.fileToJpeg = function (file, maxSide, cb) {
    var fr = new FileReader();
    fr.onerror = function () { cb(null); };
    fr.onload = function () {
      var im = new Image();
      im.onerror = function () { cb(null); };
      im.onload = function () {
        var k = Math.min(1, (maxSide || 1280) / Math.max(im.width, im.height)), w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(im, 0, 0, w, h);
        var q = 0.86, d = c.toDataURL("image/jpeg", q);
        while (d.length > 2.4 * 1024 * 1024 && q > 0.4) { q -= 0.1; d = c.toDataURL("image/jpeg", q); }
        cb(d);
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  };

  NG.blockUser = function (p, done) {
    NG.confirm("مسدود کردن " + NG.nameOf(p), "دیگه همدیگه رو نمی‌بینید، نمی‌تونید پیام بدید یا درخواست چت بفرستید و دنبال‌کردن بین‌تون برداشته می‌شه. توی ربات هم مسدود می‌شه.", "مسدود کن", function () {
      NG.api("block", { id: p.id }).then(function (r) {
        if (!r.ok) return NG.toast(NG.errText(r));
        NG.haptic("ok"); NG.toast("مسدود شد"); NG.emit("block", { id: p.id, blocked: true }); if (done) done(true);
      }).catch(NG.netErr);
    });
  };
  NG.unblockUser = function (p, done) {
    NG.api("unblock", { id: p.id }).then(function (r) {
      if (!r.ok) return NG.toast(NG.errText(r));
      NG.haptic("ok"); NG.toast("از مسدودی در آمد"); NG.emit("block", { id: p.id, blocked: false }); if (done) done(false);
    }).catch(NG.netErr);
  };

  NG.reportUser = function (p) {
    var html = '<div class="shd">گزارش ' + esc(NG.nameOf(p)) + '</div><div class="pad"><div class="rsn">' +
      REASONS.map(function (r, i) { return '<button class="rs' + (i === 0 ? " on" : "") + '" data-k="' + r[0] + '">' + esc(r[1]) + "</button>"; }).join("") +
      '</div><textarea class="inp" id="rt" rows="3" maxlength="500" placeholder="توضیح (اختیاری؛ برای «دلیل دیگر» لازمه)"></textarea>' +
      '<button class="btn" id="rp" style="width:100%;margin-top:8px">📎 افزودن عکس مدرک (اختیاری)</button><div class="rimg hide" id="ri"></div>' +
      '<div class="gerr" id="re"></div><button class="btn red tall" id="go" style="width:100%;margin-top:10px">ارسال گزارش</button></div>';
    NG.sheet(html, function (sh, close) {
      var key = "spam", img = null;
      Array.prototype.forEach.call(sh.querySelectorAll(".rs"), function (b) {
        b.onclick = function () { key = b.getAttribute("data-k"); Array.prototype.forEach.call(sh.querySelectorAll(".rs"), function (x) { x.classList.toggle("on", x === b); }); NG.haptic("sel"); };
      });
      var ri = sh.querySelector("#ri"), err = sh.querySelector("#re");
      sh.querySelector("#rp").onclick = function () {
        NG.pickImage(function (f) { NG.fileToJpeg(f, 1280, function (d) { if (!d) return NG.toast(NG.errText({ data: { error: "bad_image" } })); img = d; ri.classList.remove("hide"); ri.innerHTML = '<img alt="">'; ri.firstChild.src = d; }); });
      };
      var go = sh.querySelector("#go");
      go.onclick = function () {
        var text = sh.querySelector("#rt").value.trim();
        if (key === "other" && text.length < 3) { err.textContent = "برای «دلیل دیگر» یه توضیح کوتاه بنویس."; err.classList.add("show"); return; }
        go.disabled = true; err.classList.remove("show");
        NG.api("report", { id: p.id, reason: key, text: text, image: img || undefined }).then(function (r) {
          go.disabled = false;
          if (!r.ok) { err.textContent = r.data && r.data.error === "too_fast" ? "این کاربر رو همین الان گزارش کردی." : NG.errText(r); err.classList.add("show"); NG.haptic("err"); return; }
          NG.haptic("ok"); close(function () { NG.toast("✅ گزارشت برای ادمین‌ها ارسال شد"); });
        }).catch(function () { go.disabled = false; NG.netErr(); });
      };
    }, { cls: "tall" });
  };

  /** Settings screen: people I blocked, with «رفع مسدودی». */
  NG.openBlocked = function () {
    var w = el('<div style="min-height:100%"></div>');
    var top = NG.topbar("کاربران مسدود‌شده"); w.appendChild(top);
    var body = el('<div class="more-spin"><div class="spin"></div></div>'); w.appendChild(body);
    var scr = NG.push(w); top.querySelector(".bk").onclick = scr.close;
    NG.api("blocked_list").then(function (r) {
      body.className = ""; body.innerHTML = "";
      if (!r.ok) return NG.toast(NG.errText(r));
      if (!r.data.items.length) { body.innerHTML = NG.emptyHtml("user", "کسی رو مسدود نکردی", ""); return; }
      r.data.items.forEach(function (u) {
        var row = el('<div class="row"><div class="t"><b>' + esc(NG.nameOf(u)) + NG.vb(u) + "</b><span>" + (u.username ? esc(u.name) : "") + '</span></div><button class="fbtn gray">رفع مسدودی</button></div>');
        var rg = NG.ring(u, { noStory: true }); rg.className = "ring none"; row.insertBefore(rg, row.firstChild);
        row.querySelector("button").onclick = function (e) { e.stopPropagation(); NG.unblockUser(u, function () { row.remove(); if (!body.children.length) body.innerHTML = NG.emptyHtml("user", "کسی رو مسدود نکردی", ""); }); };
        body.appendChild(row);
      });
    }).catch(NG.netErr);
  };

  /* ---------------------------------------------------------- staff (owner / admins) */
  function badgeSheet(p, after) {
    var cur = ((p.mod && p.mod.badges) || p.bd || []).slice();
    var html = '<div class="shd">بج‌های ' + esc(NG.nameOf(p)) + '</div><div class="bgrid">' + NG.BADGE_IDS.map(function (id) {
      return '<button class="bgi' + (cur.indexOf(id) >= 0 ? " on" : "") + '" data-id="' + id + '"><span class="bgart">' + NG.BADGE_ART[id] + "</span><span>" + esc(NG.BADGE_LABEL[id] || id) + "</span></button>";
    }).join("") + '</div><div class="pad"><button class="btn blue tall" id="sv" style="width:100%">ذخیره</button></div>';
    NG.sheet(html, function (sh, close) {
      Array.prototype.forEach.call(sh.querySelectorAll(".bgi"), function (b) {
        b.onclick = function () {
          var id = b.getAttribute("data-id"), i = cur.indexOf(id);
          if (i >= 0) cur.splice(i, 1); else { if (cur.length >= 6) return NG.toast("حداکثر ۶ بج."); cur.push(id); }
          b.classList.toggle("on", i < 0); NG.haptic("sel");
        };
      });
      sh.querySelector("#sv").onclick = function () {
        NG.api("mod", { id: p.id, op: "badges", badges: cur }).then(function (r) { if (!r.ok) return NG.toast(NG.errText(r)); close(function () { NG.toast("بج‌ها ذخیره شد ✓"); after(r.data); }); }).catch(NG.netErr);
      };
    }, { cls: "tall" });
  }

  NG.staffMenu = function (p, after) {
    var m = p.mod || { banned: false, hasPhoto: !!p.av };
    function run(op, okText, extra) {
      var body = { id: p.id, op: op }; if (extra) for (var k in extra) body[k] = extra[k];
      NG.api("mod", body).then(function (r) { if (!r.ok) return NG.toast(NG.errText(r)); NG.haptic("ok"); NG.toast(okText); after(r.data); }).catch(NG.netErr);
    }
    var items = [];
    items.push(m.banned ? { label: "🔓 آن‌بن کاربر", fn: function () { run("unban", "آن‌بن شد"); } } : { label: "🚫 بن کاربر", cls: "red", fn: function () { NG.confirm("بن کاربر", "کاربر از ربات و مینی‌اپ مسدود می‌شه.", "بن کن", function () { run("ban", "بن شد"); }); } });
    items.push(p.verified ? { label: "☑️ لغو وریفای", fn: function () { run("unverify", "وریفای برداشته شد"); } } : { label: "☑️ وریفای (تیک آبی)", fn: function () { run("verify", "وریفای شد ✓"); } });
    items.push({ label: "🏅 بج‌ها", fn: function () { badgeSheet(p, after); } });
    if (m.hasPhoto) items.push({ label: "🗑 حذف عکس پروفایل", cls: "red", fn: function () { NG.confirm("حذف عکس پروفایل", "عکس پروفایل و پست اولش پاک می‌شه.", "حذف", function () { run("photo_remove", "عکس حذف شد"); }); } });
    NG.actions(items, "مدیریت " + NG.nameOf(p));
  };
})();
