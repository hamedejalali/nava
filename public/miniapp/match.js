/* نوا گرام — Matching tab: big photo card with two blurred cards stacked behind it, a pretty ❤ (likes the person's first post = profile photo),
   a small «بعدی» and a «پیام» button (chat request). Guests (not registered) see fictional-member cards and a «ثبت‌نام کن» card after the last one.
   Members WITH a photo see everyone eligible (the list restarts when it is exhausted); members without a photo get 6 cards, then «اول عکس پروفایلت رو بذار». */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num;
  var GUEST_MSG = "ابتدا ثبت‌نام کنید";

  function openBot() {
    var u = NG.bot ? "https://t.me/" + NG.bot + "?start=ng" : null;
    if (!u) return NG.toast(GUEST_MSG);
    try { if (window.Telegram && Telegram.WebApp) { Telegram.WebApp.openTelegramLink(u); return; } } catch (e) {}
    window.open(u, "_blank");
  }
  NG.openBotForSignup = openBot;
  var HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8.5-5.2-8.5-11.2A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 8.5 2.6C20.5 15.8 12 21 12 21Z" fill="currentColor"/></svg>';

  NG.matchView = function (page) {
    var cards = [], idx = 0, loading = false, seen = [], needPhoto = false, wrapped = false, busy = false;
    var root = el('<div class="mt"></div>'); page.innerHTML = ""; page.appendChild(root);

    function sub(c) { return [c.age != null ? num(c.age) + " ساله" : "", [c.city, c.province].filter(Boolean)[0] || ""].filter(Boolean).join(" • "); }

    function photo(ph, c) {
      if (c.av) ph.appendChild(NG.img(c.av)); else { ph.classList.remove("sk"); ph.appendChild(el('<div class="ph0">' + esc(String(c.name || "؟").charAt(0)) + "</div>")); }
    }
    function cardNode(c) {
      var n = el('<div class="mcard front"><div class="mph sk"></div><div class="mgr"></div><div class="mtx"><div class="mnm"></div><div class="msb"></div><div class="mbio"></div></div></div>');
      photo(n.querySelector(".mph"), c);
      n.querySelector(".mnm").innerHTML = esc(c.name) + NG.vb(c);
      n.querySelector(".msb").textContent = sub(c);
      n.querySelector(".mbio").textContent = c.bio || "";
      n.onclick = function () { if (!NG.guest) NG.openProfile(c.id); };
      return n;
    }
    function ghost(c, depth) {
      var n = el('<div class="mcard ghost g' + depth + '"><div class="mph sk"></div></div>');
      photo(n.querySelector(".mph"), c);
      return n;
    }
    function ctaNode() {
      var n = el('<div class="mcard mcta front"><div class="mctab"><div class="mbig">✨</div><h3>دوست داری بیشتر ببینی؟</h3><p>برای دیدن پروفایل‌های بیشتر، لایک کردن و گپ زدن، ثبت‌نامت رو همین‌جا (فقط چند سوال کوتاه) کامل کن.</p><button class="btn blue tall" style="width:100%">ثبت‌نام کن</button><div class="obl2">ثبت‌نام از داخل ربات</div></div></div>');
      n.querySelector("button").onclick = function () { NG.haptic("sel"); NG.openOnboarding(); };
      n.querySelector(".obl2").onclick = function () { NG.haptic("sel"); openBot(); };
      return n;
    }
    function photoNode() {
      var n = el('<div class="mcard mcta front"><div class="mctab"><div class="mbig">📸</div><h3>اول عکس پروفایلت رو بذار</h3><p>برای دیدن بقیه‌ی کارت‌ها باید عکس پروفایلت تأیید شده باشه.</p><button class="btn blue tall" style="width:100%">گذاشتن عکس پروفایل</button></div></div>');
      n.querySelector("button").onclick = function () { NG.haptic("sel"); NG.selectTab("profile", true); if (NG.changeProfilePhoto) NG.changeProfilePhoto(); };
      return n;
    }
    function render() {
      root.innerHTML = "";
      var stage = el('<div class="mstage"></div>'); root.appendChild(stage);
      var c = cards[idx];
      if (!c) {
        if (NG.guest) { stage.appendChild(ctaNode()); return; }
        if (needPhoto) { stage.appendChild(photoNode()); return; }
        if (loading) { stage.appendChild(el('<div class="more-spin"><div class="spin"></div></div>')); return; }
        stage.appendChild(el('<div class="empty">فعلاً کسی برای نمایش نیست.<br>کمی بعد دوباره سر بزن.</div>')); return;
      }
      if (cards[idx + 2]) stage.appendChild(ghost(cards[idx + 2], 2));
      if (cards[idx + 1]) stage.appendChild(ghost(cards[idx + 1], 1));
      var node = cardNode(c); stage.appendChild(node);
      var bar = el('<div class="mbar"><button class="mb sm msg" aria-label="message"><svg viewBox="0 0 24 24"><path d="M4 5.5h16v10.5H9.5L5.5 20v-4H4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span>پیام</span></button><button class="mb lk' + (c.liked ? " on" : "") + '" aria-label="like">' + HEART + '</button><button class="mb sm nx" aria-label="next"><span>بعدی</span><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>');
      bar.querySelector(".nx").onclick = function () { fly(node, "no"); };
      bar.querySelector(".msg").onclick = function () { if (NG.guest) { NG.haptic("err"); return NG.toast(GUEST_MSG); } NG.requestChat({ id: c.id, name: c.name }); };
      var lk = bar.querySelector(".lk");
      lk.onclick = function () {
        if (NG.guest) { NG.haptic("err"); return NG.toast(GUEST_MSG); }
        if (busy) return;
        NG.haptic("ok"); lk.classList.add("pop");
        if (!c.liked) NG.api("like", { pid: "pp:" + c.id, like: true }).then(function (r) { if (!r.ok) NG.fail(r); });
        c.liked = true; fly(node, "yes");
      };
      root.appendChild(bar);
    }
    function fly(node, dir) {
      if (busy) return; busy = true; NG.haptic("sel");
      node.classList.add(dir === "yes" ? "fly-yes" : "fly-no");
      setTimeout(function () { busy = false; next(); }, 260);
    }
    function next() {
      seen.push(cards[idx] && cards[idx].id); idx++;
      if (!NG.guest && idx >= cards.length - 3) more();
      render();
    }
    function more() {
      if (loading || NG.guest || needPhoto) return; loading = true;
      NG.api("match_cards", { exclude: seen.filter(Boolean).slice(-300) }).then(function (r) {
        loading = false;
        if (!r.ok) {
          var e = r.data && r.data.error;
          if (e === "need_photo") { needPhoto = true; render(); return; }
          if (cards.length === 0) root.innerHTML = '<div class="empty">' + esc(NG.errText(r)) + "</div>";
          return;
        }
        var got = r.data.cards || [];
        if (!got.length && seen.length && !wrapped) { wrapped = true; seen = []; more(); return; } // everybody was shown once: start over
        if (got.length) wrapped = false;
        cards = cards.concat(got); render();
      }).catch(function () { loading = false; });
    }
    function load() {
      root.innerHTML = '<div class="more-spin"><div class="spin"></div></div>';
      if (NG.guest) {
        NG.api("guest_cards").then(function (r) {
          if (!r.ok) return NG.fail(r);
          cards = r.data.cards || []; NG.bot = r.data.bot || NG.bot; render();
        }).catch(function () { NG.netErr(); });
      } else more();
    }
    load();
    return { reload: function () { if (!cards.length || (!NG.guest && idx >= cards.length && !needPhoto)) { idx = 0; cards = []; seen = []; wrapped = false; load(); } } };
  };
})();
