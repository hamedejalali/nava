/* نوا گرام — Matching tab (v1.23, rewritten). One person at a time: the whole photo (never cropped, rounded corners), name + tick, age • city, bio,
   and three round buttons: ✕ next · ❤ like (likes the person's profile-photo post) · 💬 chat request.
   Guests (not registered) see fictional members and a «ثبت‌نام کن» card at the end. Members without a photo get 6 cards, then «اول عکس پروفایلت رو بذار». */
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
  var I_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-8.5-5.2-8.5-11.2A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 8.5 2.6C20.5 15.8 12 21 12 21Z" fill="currentColor"/></svg>';
  var I_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
  var I_MSG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10.5H9.5L5.5 20v-4H4Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';

  NG.matchView = function (page) {
    var cards = [], idx = 0, loading = false, exhausted = false, seen = [], needPhoto = false, wrapped = false, lock = false, token = 0;
    var root = el('<div class="mx"></div>'); page.innerHTML = ""; page.appendChild(root);

    function sub(c) { return [c.age != null ? num(c.age) + " ساله" : "", [c.city, c.province].filter(Boolean)[0] || ""].filter(Boolean).join(" • "); }

    function ctaCard(icon, title, text, label, fn, extra) {
      var n = el('<div class="mx-cta"><div class="mx-big">' + icon + "</div><h3>" + esc(title) + "</h3><p>" + esc(text) + '</p><button class="btn blue tall">' + esc(label) + "</button>" + (extra ? '<div class="mx-alt">' + esc(extra.label) + "</div>" : "") + "</div>");
      n.querySelector("button").onclick = function () { NG.haptic("sel"); fn(); };
      if (extra) n.querySelector(".mx-alt").onclick = function () { NG.haptic("sel"); extra.fn(); };
      return n;
    }

    function stateNode() {
      if (NG.guest) return ctaCard("✨", "دوست داری بیشتر ببینی؟", "برای دیدن پروفایل‌های بیشتر، لایک کردن و گپ زدن، ثبت‌نامت رو کامل کن (فقط چند سوال کوتاه).", "ثبت‌نام کن", function () { NG.openOnboarding(); }, { label: "ثبت‌نام از داخل ربات", fn: openBot });
      if (needPhoto) return ctaCard("📸", "اول عکس پروفایلت رو بذار", "برای دیدن بقیه‌ی کارت‌ها باید عکس پروفایلت تأیید شده باشه.", "گذاشتن عکس پروفایل", function () { NG.selectTab("profile", true); if (NG.changeProfilePhoto) NG.changeProfilePhoto(); });
      if (loading) return el('<div class="more-spin" style="margin:auto"><div class="spin"></div></div>');
      return ctaCard("🔎", "فعلاً کسی برای نمایش نیست", "کمی بعد دوباره سر بزن یا لیست رو از اول ببین.", "از اول", function () { restart(); });
    }

    function render() {
      root.innerHTML = "";
      var c = cards[idx];
      if (!c) { root.appendChild(stateNode()); return; }
      var card = el('<div class="mx-card"><div class="mx-ph sk"></div><div class="mx-info"><div class="mx-nm"></div><div class="mx-sb"></div><div class="mx-bio"></div></div></div>');
      var ph = card.querySelector(".mx-ph");
      if (c.av) ph.appendChild(NG.img(c.av, "mx-img")); else { ph.classList.remove("sk"); ph.classList.add("none"); ph.appendChild(el('<div class="mx-0">' + esc(String(c.name || "؟").charAt(0)) + "</div>")); }
      card.querySelector(".mx-nm").innerHTML = "<span>" + esc(c.name) + "</span>" + NG.vb(c);
      card.querySelector(".mx-sb").textContent = sub(c);
      var bio = card.querySelector(".mx-bio"); bio.textContent = c.bio || ""; if (!c.bio) bio.remove();
      if (!NG.guest) { ph.onclick = card.querySelector(".mx-info").onclick = function () { NG.openProfile(c.id); }; }
      root.appendChild(card);
      var bar = el('<div class="mx-bar"><button class="mx-b nx" aria-label="next">' + I_X + '</button><button class="mx-b lk' + (c.liked ? " on" : "") + '" aria-label="like">' + I_HEART + '</button><button class="mx-b ms" aria-label="message">' + I_MSG + "</button></div>");
      bar.querySelector(".nx").onclick = function () { go(card, "no"); };
      bar.querySelector(".ms").onclick = function () { if (NG.guest) { NG.haptic("err"); return NG.toast(GUEST_MSG); } NG.requestChat({ id: c.id, name: c.name }); };
      var lk = bar.querySelector(".lk");
      lk.onclick = function () {
        if (NG.guest) { NG.haptic("err"); return NG.toast(GUEST_MSG); }
        if (lock) return;
        NG.haptic("ok"); lk.classList.add("pop");
        if (!c.liked) NG.api("like", { pid: "pp:" + c.id, like: true }).then(function (r) { if (!r.ok) NG.fail(r); });
        c.liked = true; go(card, "yes");
      };
      root.appendChild(bar);
    }

    /* animate out, then ALWAYS advance (the timer is the single source of truth — no state can get stuck) */
    function go(card, dir) {
      if (lock) return; lock = true; NG.haptic("sel");
      card.classList.add(dir === "yes" ? "fly-yes" : "fly-no");
      setTimeout(function () { lock = false; advance(); }, 230);
    }
    function advance() {
      var c = cards[idx]; if (c) seen.push(c.id);
      idx++;
      render();
      if (!NG.guest && cards.length - idx <= 3) more();
    }

    function more() {
      if (loading || NG.guest || needPhoto || exhausted) return;
      loading = true; var my = ++token;
      NG.api("match_cards", { exclude: seen.filter(Boolean).slice(-300) }).then(function (r) {
        if (my !== token) return;
        loading = false;
        if (!r.ok) {
          if (r.data && r.data.error === "need_photo") { needPhoto = true; render(); return; }
          if (!cards[idx]) { render(); NG.toast(NG.errText(r)); }
          return;
        }
        var have = {}; cards.forEach(function (x) { have[x.id] = 1; });
        var got = (r.data.cards || []).filter(function (x) { return !have[x.id]; });
        if (!got.length) {
          if (seen.length && !wrapped) { wrapped = true; seen = []; more(); return; } // everybody was shown once: start over
          exhausted = true; if (!cards[idx]) render(); return;
        }
        wrapped = false; cards = cards.concat(got);
        if (!root.querySelector(".mx-card")) render();
      }).catch(function () { if (my === token) { loading = false; if (!cards[idx]) render(); } });
    }

    function restart() { idx = 0; cards = []; seen = []; wrapped = false; exhausted = false; needPhoto = false; token++; loading = false; load(); }
    function load() {
      render();
      if (NG.guest) {
        loading = true; render();
        NG.api("guest_cards").then(function (r) {
          loading = false;
          if (!r.ok) return NG.fail(r);
          cards = r.data.cards || []; NG.bot = r.data.bot || NG.bot; render();
        }).catch(function () { loading = false; NG.netErr(); });
      } else { loading = false; more(); render(); }
    }
    load();
    return { reload: function () { if (!cards[idx] && !loading) restart(); } };
  };
})();
