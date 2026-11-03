# افزودن بازی جدید به مویاگرام (راهنمای ماژول بازی)

هدف: بازی بعدی فقط **چند فایل جدید** باشد؛ کل zip عوض نشود. Claude بازی + تست‌هایش را می‌نویسد و فقط فایل‌های زیر را تحویل می‌دهد.

## فایل‌هایی که یک بازی تحویل می‌دهد
| فایل | کار |
|---|---|
| `src/services/games/<id>/index.ts` | منطق بازی + `export default` یک `GameModule` (عمل‌ها، خطاها، pulse، sweep) |
| `public/miniapp/games/<id>.js` | رابط بازی؛ با `NG.registerGame({id,name,bg,logo,open})` در هاب ثبت می‌شود |
| `tests/regression/game-<id>.test.ts` | تست‌های بازی (شامل جریان ژتون) |
| `public/miniapp/games/<id>.css` (اختیاری) | استایل؛ از داخل فایل js لود می‌شود |

## دو خطِ ثبت (تنها ویرایش فایل‌های موجود)
1. `src/services/games/modules.ts`: `import chess from "./chess/index.js";` و اضافه کردن `chess` به آرایه‌ی `GAME_MODULES`.
2. `public/miniapp/games/manifest.js`: اضافه کردن `"chess"` به `NG.GAME_FILES`.

بعدش خودکار می‌شود: whitelist اکشن‌ها، قوانین مهمان (guest)، جلوگیری از بازی کردن ادمین به‌جای دیگران، خطاها→HTTP، pulse (نقطه‌ی قرمز نوبت)، sweep روزانه‌ی کران، و کاشی بازی در هاب (جای «به‌زودی»). با اجرای تست‌ها، اشتباه در نام‌گذاری یا تکراری بودن همان لحظه‌ی استارت خطا می‌دهد.

## قرارداد `GameModule` (`src/services/games/registry.ts`)
* `id`: حروف کوچک (مثلاً `chess`)؛ نام همه‌ی اکشن‌ها با `chess_` شروع شود (`chess_create`, `chess_move`, …).
* `actions[name] = { handle(me, body, {guest}), guest?, actingBlocked? }` — خطاهای مورد انتظار را با `throw new SocialError("کد")` بده و کدش را در `errors` به HTTP نگاشت کن.
* `sweep()`: بازی‌های رهاشده را تمام، ژتونِ نگه‌داشته‌شده را برگردان، تاریخچه‌ی قدیمیِ تسویه‌شده را پاک کن.

## جریان ژتون (مهم‌ترین قسمت) — فقط از `gameWallet` استفاده کن
`src/services/games/wallet.ts`:
* هر حرکت پول = یک ردیف لجر با شناسه‌ی قطعی `g:<game>:<gameId>:hold|pay|back:<userId>` → دوبار-کلیک/ری‌تری/تحویل دوباره هیچ‌وقت دوبار کسر یا پرداخت نمی‌کند.
* `hold` همراه ساخت/تغییر داکیومنت بازی در **یک تراکنش** (`runInTransaction`) باشد.
* تسویه فقط یک بار: پرچم `settled` با compare-and-set روی داکیومنت + شناسه‌ی لجر.
* روی کالکشن بازی **TTL نگذار**؛ بازی تسویه‌نشده هرگز پاک نشود (باگی که در تخته‌نرد بود).
* شرط‌بندی به‌صورت پیش‌فرض **خاموش** است (`gameWallet(game, id, { enabled: false })` خطا می‌دهد). تا وقتی کل جریان بازبینی نشده، خاموش بماند و سمت سرور هر مقدار غیرصفر را `stakes_disabled` رد کن (مثل `backgammonGames.create`).
* گزارش/بازپرداخت: `scripts/bg-reconcile.ts` الگوی کار است؛ برای بازی جدید با `g:<game>:` تعمیم بده.

## رابط کاربری
`public/miniapp/games/<id>.js`:
```js
(function () { var NG = window.NG;
  NG.registerGame({ id: "chess", name: "شطرنج", bg: "linear-gradient(150deg,#3b4252,#1b1f2a)", logo: "<svg…/>",
    open: function () { /* NG.push(...) صفحه‌ی بازی؛ NG.api("chess_create", {...}) */ } });
})();
```
* برای نمایش ژتون/پروفایل/اشتراک از همان کمک‌های `NG` (مثل `NG.api`, `NG.push`, `NG.toast`, `NG.haptic`) استفاده کن.
* اگر نسخه‌ی کلاینت عوض شد، `?v=` خودکار با `NG.VER` می‌آید؛ کش با شماره‌ی نسخه‌ی پروژه نو می‌شود (آخر کار نسخه را بالا ببر).

## چک‌لیست تحویل هر بازی
1. `npx tsc --noEmit` و `npm test` سبز.
2. تست‌های جریان ژتون: کسر، پرداخت، بازپرداخت، تکرار درخواست (idempotent)، ژتون ناکافی، بن/بلاک.
3. گزارش صادقانه: چه چیزی تست شد و چه چیزی فقط خوانده شد.
