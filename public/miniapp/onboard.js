/* نوا گرام — registration inside the app (same questions / same result as the bot): gender → age → province → city → name.
   Saved in ONE server call; the bot then shows its normal "profile complete" message + main menu. */
(function () {
  "use strict";
  var NG = window.NG, el = NG.el, esc = NG.esc, num = NG.num;
  var NICK_RE = /^[آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی‌ ]+$/;
  var BAD = { invalid_gender: "جنسیت رو انتخاب کن.", invalid_age: "سن معتبر نیست.", invalid_province: "استان معتبر نیست.", invalid_city: "شهر معتبر نیست.", invalid_nickname: "نام باید فارسی باشه (حداکثر ۳۲ حرف).", banned: "حساب شما مسدود شده.", already: "ثبت‌نامت قبلاً کامل شده." };

  NG.openOnboarding = function () {
    var S = { gender: null, age: "", province: null, provinceName: "", city: null, cityName: "", nickname: "", minAge: 9, maxAge: 99, provinces: [], cities: [] };
    var step = 0, busy = false;
    var ov = el('<div class="ob"><div class="obh"><button class="obx" aria-label="close">✕</button><div class="obdots"></div></div><div class="obb"></div><div class="obf"></div></div>');
    document.body.appendChild(ov);
    var body = ov.querySelector(".obb"), foot = ov.querySelector(".obf"), dots = ov.querySelector(".obdots");
    ov.querySelector(".obx").onclick = function () { ov.remove(); };

    function paintDots() { dots.innerHTML = ""; for (var i = 0; i < 5; i++) dots.appendChild(el('<i class="' + (i < step ? "d" : i === step ? "c" : "") + '"></i>')); }
    function next(btn, label, ok) {
      foot.innerHTML = ""; var b = el('<button class="btn blue tall" style="width:100%">' + esc(label) + "</button>");
      b.disabled = !ok; b.onclick = function () { if (!b.disabled) go(btn); }; foot.appendChild(b); return b;
    }
    function go(n) { step = n; render(); }
    function title(t, sub) { body.innerHTML = '<h2 class="obt">' + esc(t) + "</h2>" + (sub ? '<p class="obs">' + esc(sub) + "</p>" : ""); }

    function stepGender() {
      title("جنسیتت چیه؟", "بعد از ثبت‌نام قابل تغییر نیست.");
      var row = el('<div class="obg"></div>');
      [["female", "👩", "زن"], ["male", "👨", "مرد"]].forEach(function (g) {
        var c = el('<button class="obc' + (S.gender === g[0] ? " on" : "") + '"><span>' + g[1] + "</span><b>" + g[2] + "</b></button>");
        c.onclick = function () { S.gender = g[0]; NG.haptic("sel"); setTimeout(function () { go(1); }, 120); };
        row.appendChild(c);
      });
      body.appendChild(row); foot.innerHTML = "";
    }
    function stepAge() {
      title("چند سالته؟", "بین " + num(S.minAge) + " تا " + num(S.maxAge));
      var inp = el('<input class="inp obi" inputmode="numeric" maxlength="3" placeholder="سن" value="' + esc(S.age) + '">');
      body.appendChild(inp);
      var btn = next(2, "ادامه", false);
      function chk() { var n = Number(String(inp.value).replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })); S.age = String(n || ""); btn.disabled = !(Number.isInteger(n) && n >= S.minAge && n <= S.maxAge); }
      inp.oninput = chk; chk(); setTimeout(function () { inp.focus(); }, 150);
    }
    function pickList(items, cur, onPick, ph) {
      var q = el('<input class="inp obi" placeholder="' + esc(ph) + '">'); var list = el('<div class="obl"></div>');
      function paint() {
        list.innerHTML = ""; var t = q.value.trim();
        items.filter(function (x) { return !t || x.name.indexOf(t) >= 0; }).slice(0, 80).forEach(function (x) {
          var r = el('<button class="obr' + (x.id === cur ? " on" : "") + '">' + esc(x.name) + "</button>"); r.onclick = function () { NG.haptic("sel"); onPick(x); }; list.appendChild(r);
        });
        if (!list.firstChild) list.appendChild(el('<div class="empty" style="padding:24px">چیزی پیدا نشد.</div>'));
      }
      q.oninput = paint; paint(); body.appendChild(q); body.appendChild(list);
    }
    function stepProvince() {
      title("کدوم استانی؟"); foot.innerHTML = "";
      pickList(S.provinces, S.province, function (p) { if (S.province !== p.id) { S.city = null; S.cityName = ""; S.cities = []; } S.province = p.id; S.provinceName = p.name; go(3); }, "جستجوی استان");
    }
    function stepCity() {
      title("کدوم شهر؟", S.provinceName); foot.innerHTML = "";
      var show = function () { pickList(S.cities, S.city, function (c) { S.city = c.id; S.cityName = c.name; go(4); }, "جستجوی شهر"); };
      if (S.cities.length) return show();
      body.appendChild(el('<div class="more-spin"><div class="spin"></div></div>'));
      NG.api("onboard_cities", { province: S.province }).then(function (r) {
        if (!r.ok) return NG.toast("دریافت شهرها انجام نشد.");
        S.cities = r.data.cities || []; title("کدوم شهر؟", S.provinceName); show();
      }).catch(function () { NG.netErr(); });
    }
    function stepName() {
      title("اسم مستعارت چیه؟", "فارسی بنویس؛ همین اسم به بقیه نشون داده می‌شه.");
      var inp = el('<input class="inp obi" maxlength="32" placeholder="نام مستعار" value="' + esc(S.nickname) + '">'); body.appendChild(inp);
      var msg = el('<div class="gerr" id="obe"></div>'); body.appendChild(msg);
      var btn = next(5, "تکمیل ثبت‌نام", false);
      function chk() { S.nickname = inp.value.replace(/\s+/g, " ").trim(); var ok = S.nickname.length > 0 && S.nickname.length <= 32 && NICK_RE.test(S.nickname); btn.disabled = !ok; msg.textContent = S.nickname && !ok ? "فقط حروف فارسی مجازه." : ""; msg.classList.toggle("show", !!msg.textContent); }
      inp.oninput = chk; chk();
      btn.onclick = function () {
        if (busy || btn.disabled) return; busy = true; btn.disabled = true;
        NG.api("onboard_save", { gender: S.gender, age: Number(S.age), province: S.province, city: S.city, nickname: S.nickname }).then(function (r) {
          busy = false;
          if (!r.ok) { btn.disabled = false; var e = r.data && r.data.error; NG.haptic("err"); msg.textContent = BAD[e] || NG.errText(r, "ثبت‌نام انجام نشد."); msg.classList.add("show"); return; }
          NG.haptic("ok"); body.innerHTML = '<div class="obdone"><div class="mbig">🎉</div><h2 class="obt">ثبت‌نامت کامل شد!</h2><p class="obs">یه پیام هم داخل ربات برات فرستادیم.</p></div>'; foot.innerHTML = ""; dots.innerHTML = "";
          setTimeout(function () { location.reload(); }, 1100);
        }).catch(function () { busy = false; btn.disabled = false; NG.netErr(); });
      };
    }
    function render() {
      paintDots(); body.scrollTop = 0;
      [stepGender, stepAge, stepProvince, stepCity, stepName][Math.min(step, 4)]();
    }
    // start where the bot left off: already-known answers are kept
    body.innerHTML = '<div class="more-spin"><div class="spin"></div></div>';
    NG.api("onboard_state").then(function (r) {
      if (!r.ok) { ov.remove(); return NG.fail(r); }
      var d = r.data;
      if (d.completed) { location.reload(); return; }
      S.minAge = d.minAge; S.maxAge = d.maxAge; S.provinces = d.provinces || [];
      if (d.gender) S.gender = d.gender;
      if (d.age) S.age = String(d.age);
      if (d.province) { S.province = d.province; var pv = S.provinces.filter(function (p) { return p.id === d.province; })[0]; S.provinceName = pv ? pv.name : d.province; }
      if (d.city) { S.city = d.city; S.cityName = d.city; }
      if (d.nickname) S.nickname = d.nickname;
      step = !S.gender ? 0 : !S.age ? 1 : !S.province ? 2 : !S.city ? 3 : 4;
      render();
    }).catch(function () { ov.remove(); NG.netErr(); });
  };
})();
