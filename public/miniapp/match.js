/* نوا گرام — Matching tab: big photo card + «بعدی». Guests (not registered in the bot) see 5 fictional-member cards, can't like
   or open anything else, and get a «ثبت‌نام کن» card after the fifth. Members see real eligible people (they need their own photo). */
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

  NG.matchView = function (page) {
    var cards = [], idx = 0, loading = false, seen = [];
    var root = el('<div class="mt"></div>'); page.innerHTML = ""; page.appendChild(root);

    function sub(c) { return [c.age != null ? num(c.age) + " ساله" : "", [c.city, c.province].filter(Boolean)[0] || ""].filter(Boolean).join(" • "); }

    function cardNode(c) {
      var n = el('<div class="mcard"><div class="mph sk"></div><div class="mgr"></div><div class="mtx"><div class="mnm"></div><div class="msb"></div><div class="mbio"></div></div></div>');
      var ph = n.querySelector(".mph");
      if (c.av) ph.appendChild(NG.img(c.av)); else { ph.classList.remove("sk"); ph.appendChild(el('<div class="ph0">' + esc(String(c.name || "؟").charAt(0)) + "</div>")); }
      n.querySelector(".mnm").textContent = c.name + (c.verified ? " ✔" : "");
      n.querySelector(".msb").textContent = sub(c);
      n.querySelector(".mbio").textContent = c.bio || "";
      return n;
    }
    function ctaNode() {
      var n = el('<div class="mcard mcta"><div class="mctab"><div class="mbig">✨</div><h3>دوست داری بیشتر ببینی؟</h3><p>برای دیدن پروفایل‌های بیشتر، لایک کردن و گپ زدن، ثبت‌نامت رو همین‌جا (فقط چند سوال کوتاه) کامل کن.</p><button class="btn blue tall" style="width:100%">ثبت‌نام کن</button><div class="obl2">ثبت‌نام از داخل ربات</div></div></div>');
      n.querySelector("button").onclick = function () { NG.haptic("sel"); NG.openOnboarding(); };
      n.querySelector(".obl2").onclick = function () { NG.haptic("sel"); openBot(); };
      return n;
    }
    function render() {
      root.innerHTML = "";
      var stage = el('<div class="mstage"></div>'); root.appendChild(stage);
      var c = cards[idx];
      if (!c) {
        if (NG.guest) { stage.appendChild(ctaNode()); return; }
        stage.appendChild(el('<div class="empty">فعلاً کسی برای نمایش نیست.<br>کمی بعد دوباره سر بزن.</div>')); return;
      }
      stage.appendChild(cardNode(c));
      var bar = el('<div class="mbar"><button class="mb x" aria-label="next"><span>بعدی</span></button><button class="mb h" aria-label="like">♥</button></div>');
      bar.querySelector(".x").onclick = next;
      bar.querySelector(".h").onclick = function () {
        if (NG.guest) { NG.haptic("err"); return NG.toast(GUEST_MSG); }
        NG.haptic("ok"); NG.api("like", { pid: "pp:" + c.id, like: true }).then(function (r) { if (!r.ok) return NG.fail(r); NG.toast("❤️"); next(); });
      };
      root.appendChild(bar);
      var cnt = el('<div class="mcnt">' + num(Math.min(idx + 1, cards.length)) + " / " + num(cards.length) + "</div>"); root.insertBefore(cnt, stage);
    }
    function next() { NG.haptic("sel"); seen.push(cards[idx] && cards[idx].id); idx++; if (!NG.guest && idx >= cards.length - 2) more(); render(); }
    function more() {
      if (loading || NG.guest) return; loading = true;
      NG.api("match_cards", { exclude: seen.filter(Boolean).slice(-60) }).then(function (r) {
        loading = false;
        if (!r.ok) { if (cards.length === 0) { var e = r.data && r.data.error; root.innerHTML = '<div class="empty">' + esc(e === "need_photo" ? "برای دیدن کارت‌ها اول باید عکس پروفایلت تأیید شده باشه." : NG.errText(r)) + "</div>"; } return; }
        cards = cards.concat(r.data.cards || []); render();
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
    return { reload: function () { if (!cards.length || (!NG.guest && idx >= cards.length)) { idx = 0; cards = []; seen = []; load(); } } };
  };
})();
