# گزارش ممیزی مستقل MoyaGram — نسخهٔ 1.29.7

**تاریخ ممیزی:** 2026-11-10  
**آرشیو مبنا:** `nava-project-v1.29.7-full.zip`  
**روش:** بررسی ایستای سورس، اسناد، تنظیمات، اسکریپت‌های بررسی و مسیرهای حساس؛ بدون اتصال به محیط عملیاتی.

## 1. رأی نهایی

**وضعیت: NOT VERIFIED FOR PRODUCTION — انتشار Production از روی این ممیزی تأیید نمی‌شود.**

آرشیو سالم است و شناسهٔ نسخه در فایل‌های اصلی یکپارچه است. تعدادی از قابلیت‌های زیرساختی مانند connection pooling، timeout، rate/monitoring metrics، صف‌های پایدار، runbook انتشار و scriptهای static-check در سورس حاضرند. با این حال، چند نقص مشخص در مسیرهای مالی، کنترل درخواست، تغییر سن و تعداد Queryهای دیتابیس باقی است.

**هیچ فایل اجرایی یا منطق محصولی در این ممیزی تغییر داده نشد.** دلیل: `npm ci` در محیط ممیزی با timeout متوقف شد؛ در نتیجه امکان اجرای معتبر TypeScript، کل تست‌ها و Build وجود نداشت. اعمال patch در مسیرهای مالی، مجوزدهی، سن یا تراکنش دیتابیس بدون اجرای تست Regression، ریسک غیرقابل‌قبولی داشت. تنها این گزارش مستقل به پوشهٔ `docs/` اضافه شده است.

این گزارش ادعای «آمادهٔ Production»، «آمادهٔ یک میلیون کاربر»، «کاملاً امن» یا «بدون باگ» ندارد.

## 2. صحت آرشیو و بررسی‌های قابل اجرا

| بررسی | نتیجه | جزئیات |
|---|---|---|
| سلامت ZIP | PASS | `unzip -t` بدون خطای آرشیو |
| ساختار | PASS | 395 فایل استخراج‌شده |
| تطبیق نسخه‌ها | PASS | `package.json`، دو مقدار نسخه در `package-lock.json`، `version.ts`، `CHANGELOG` و Mini App همگی 1.29.7 |
| تطبیق کلیدهای dependency | PASS | کلیدهای وابستگی package و lock یکسان‌اند |
| اسکن Secret در Working Tree | PASS | `scripts/check-secrets.mjs` موردی پیدا نکرد؛ Git history اسکن نشده است |
| بررسی ایستای Mini App | PASS | 14 اسکریپت parse شدند؛ ارجاع فایل‌های محلی معتبر و ترتیب `core.js … main.js` صحیح بود |
| `npm ci` | BLOCKED | نصب به‌علت timeout شبکه کامل نشد؛ `node_modules` ایجادشده ناقص بود |
| TypeScript | NOT VERIFIED | اجرای `tsc` سراسری به‌علت نبودن type packageها (`node`، `json-schema`، `webidl-conversions`، `whatwg-url`) متوقف شد؛ این خروجی مدرک خطای سورس نیست |
| `npm test` | NOT RUN | وابستگی `tsx` در نصب ناقص در دسترس نبود |
| `npm run build` | NOT VERIFIED | پیش‌نیازهای TypeScript کامل نصب نشده بود |
| `npm audit` | NOT RUN | نصب/دسترسی رجیستری در این محیط قابل اتکا نبود |
| MongoDB واقعی / Telegram / Vercel | NOT VERIFIED | دسترسی یا محیط آزمایشی واقعی در اختیار ممیزی نبود |

اسکریپت‌های زیر مستقلاً اجرا و موفق شدند:

```text
node scripts/check-versions.mjs
node scripts/check-secrets.mjs
node scripts/check-miniapp.mjs
```

گزارش داخلی `docs/AUDIT_v1.29.7.md` نیز تصریح می‌کند که تست‌های تغییرات نسخه Mock هستند. آن تست‌ها را معادل تست MongoDB واقعی، Replica Set، Telegram یا Vercel محسوب نکردم.

**محدودیت مقایسهٔ نسخه‌ای:** آرشیو کامل نسخهٔ 1.29.6 در این نوبت موجود نبود؛ بنابراین Diff واقعی فایل‌به‌فایل `1.29.6 → 1.29.7` قابل انجام نبود. `CHANGELOG.md` و گزارش داخلی نسخه بررسی شدند، اما ادعای تغییرات را معادل Git diff مستقل نمی‌دانم.

## 3. یافته‌های مهم با اولویت

### P1 — باید پیش از Production تعیین تکلیف شوند

**A-01 — Fail-open بودن Rate Limiter مینی‌اپ**  
فایل: `api/miniapp.ts` حدود خطوط 295–303. اگر `checkRateLimit()` خطا بدهد، خطا فقط log می‌شود و درخواست ادامه پیدا می‌کند. این رفتار صریحاً در کد با عنوان fail-open آمده است. در زمان اختلال یا کندی دیتابیس، سقف 300 درخواست در دقیقه می‌تواند عملاً دور زده شود. پیشنهاد اصلاح: پاسخ کنترل‌شدهٔ `503` یا سیاست محدودکنندهٔ جایگزین؛ نه ادامهٔ بدون محدودیت. به‌دلیل اثر روی availability و abuse protection، Patch باید با تست خطای Rate Limit و تست رفتار سایر APIها انجام شود.

**A-02 — از دست رفتن دائمی رسید کانال لاگ واریز**  
فایل: `src/services/wallet/walletDeposits.ts` حدود خطوط 213–231. `logNotifiedAt` پیش از فراخوانی `sendMessage` ثبت می‌شود. اگر Process بعد از ثبت claim و قبل از ارسال متوقف شود، این فیلد باقی می‌ماند و تلاش مجدد انجام نمی‌شود. اگر `getLogChatId()` مقدار `undefined` برگرداند نیز claim ثبت‌شده باقی می‌ماند. `retryPendingAnnouncements()` فقط ردیف‌هایی را انتخاب می‌کند که `notifiedAt` کاربر وجود ندارد؛ بنابراین اگر اعلان کاربر موفق شده ولی رسید کانال لاگ جا مانده باشد، این مسیر آن را بازیابی نمی‌کند. باید اعلان کانال به Outbox/Lease مستقل با Attempt، Expiry و Retry تبدیل شود. تضمین Exactly-once بین MongoDB و Telegram ممکن نیست؛ semantics مناسب At-least-once با dedupe و ثبت نتیجه است.

**A-03 — ارتباط فعال پس از تغییر ردهٔ سنی**  
فایل‌ها: `src/features/matching/profileEdit.ts` حدود خطوط 344–350 و `src/features/matching/relayShared.ts` حدود خطوط 17–35. تأیید تغییر سن مستقیماً مقدار `age` را به‌روزرسانی می‌کند؛ مسیر Relay نشست فعال را بررسی می‌کند، اما قبل از انتقال پیام، سن/Block/Ban فعلی دو طرف را دوباره نمی‌سنجد و نشست را هم به‌دلیل تغییر Band نمی‌بندد. بنابراین ممکن است رابطه‌ای که پیش از تغییر سن مجاز بوده بعد از تغییر Band ادامه پیدا کند. اصلاح باید با سیاست مشخص پایان نشست، بازپرداخت طبق قواعد فعلی، تراکنش اتمیک و اعلان قابل‌بازیابی طراحی شود. تغییر فوری و ناقص می‌تواند کاربران را در نشست نیمه‌بسته یا وضعیت مالی نادرست قرار دهد.

**A-04 — N+1 واقعی در Explore و DM Overview**  
فایل‌ها: `src/services/nava/search.ts` حدود خطوط 20–47 و `src/services/nava/dm.ts` حدود خطوط 106–140.

- Explore برای هر یک از حداکثر 24 کاربر صفحه، یک Query مجزا برای آخرین پست می‌فرستد.
- DM Overview برای هر یک از حداکثر 40 نشست، Query جداگانهٔ آخرین پیام و در صورت Active بودن، `countDocuments` جداگانهٔ Unread اجرا می‌کند؛ در بدترین حالت تا حدود 80 Query اضافی برای یک درخواست DM Overview.
- بخش DM این Queryها را در حلقه و عمدتاً به‌شکل متوالی اجرا می‌کند.

`executionStats` و Benchmark اجرا شود. در این ممیزی patch نشده چون تست/DB لازم در دسترس نبود.

### P2 — مهم، ولی نیازمند داده یا محیط آزمایشی

**A-05 — امضای لینک Media تاریخ انقضا ندارد**  
`src/services/nava/media.ts` حدود خطوط 42–76. Cache رسانهٔ کاربر از shared/public به `private` تغییر کرده، اما Cache محلی می‌تواند برای DM یک ساعت و برای سایر رسانه‌ها هفت روز بماند. امضای URL اشتراکی نیز expiry ندارد و با کلید مشتق‌شده از BOT_TOKEN تولید می‌شود. حذف رسانه از Origin، نسخهٔ ذخیره‌شده روی دستگاه کاربر را فوراً پاک نمی‌کند و URL اشتراکی قدیمی از نظر زمانی منقضی نمی‌شود. افزودن expiry به لینک‌هایی که Telegram قبلاً دریافت کرده ممکن است اشتراک‌های قدیمی را بشکند؛ باید سیاست نگهداری/ابطال و سازگاری با لینک‌های قبلی مشخص شود.

**A-06 — مانیتورینگ Query دیتابیس محدودتر از نیاز واقعی است**  
`scripts/explain-hot-queries.ts` عمدتاً سه Query لیست کاربران را بررسی می‌کند و Queryهای Explore، DM Overview، Feed و مسیرهای پرمصرف دیگر را پوشش نمی‌دهد. در حال حاضر بدون اتصال به Staging هیچ ادعایی دربارهٔ ایندکس بهینه یا توان یک میلیون کاربر قابل تأیید نیست.

**A-07 — forced sync کیف پول می‌تواند درخواست هم‌زمان ایجاد کند**  
`src/services/wallet/walletDeposits.ts` و فراخوان‌های `force: true` در `src/features/shop/shop.ts`، `src/features/admin/walletAdmin.ts` و Cron. مسیرهای force قفل کوتاه sync را دور می‌زنند. شناسهٔ یکتای تراکنش و Ledger از اعتباردهی تکراری جلوگیری می‌کند، اما درخواست هم‌زمان به سرویس Wallet و ثبت `errorStreak` می‌تواند زیاد شود. باید با کنترل هم‌زمانی جدا از idempotency بررسی شود؛ دوباره‌کاری مالی در این بررسی اثبات نشده است.

**A-08 — خروجی/بازیابی Excel قابلیت ادامه از نقطهٔ توقف ندارد**  
`src/features/admin/userBackup.ts` حدود خطوط 98–145. Export/Import هرکدام در یک `waitUntil` و یک Invocation اجرا می‌شوند؛ checkpoint/resume واقعی یا Job پایدار چندمرحله‌ای دیده نشد. فایل Excel پشتیبان کامل دیتابیس نیست؛ اسناد `BACKUP_RESTORE.md` به‌درستی این محدودیت را توضیح می‌دهند. از Excel برای بازیابی Ledger یا همهٔ Collectionها استفاده نشود.

**A-09 — CI واقعی در مخزن پیکربندی نشده**  
`npm run verify` و `npm run verify:ci` و راهنمای Provider-neutral وجود دارد، اما فایل Workflow برای GitHub Actions/GitLab/Azure/Jenkins در آرشیو پیدا نشد. بنابراین Release Gate در سطح اسکریپت آماده است، ولی اجرای خودکار CI از روی این ZIP اثبات نمی‌شود.

## 4. ارزیابی 31 پیشنهاد عملکرد

| # | پیشنهاد | وضعیت | شواهد و تصمیم |
|---:|---|---|---|
| 1 | JavaScript Code Splitting | DEFER | Mini App از اسکریپت‌های Classic با ترتیب و Global `NG` استفاده می‌کند. شکستن Bundle بدون اندازه‌گیری و تست ترتیب Init ریسک دارد. |
| 2 | WebP / AVIF | DEFER | دریافت WebP پشتیبانی می‌شود، اما Pipeline تبدیل/Thumbnail اثبات نشده. اصل رسانهٔ کاربر باید حفظ شود. |
| 3 | حذف درخواست تکراری | DEFER | شواهد کافی از تکرار واقعی در تمام مسیرها موجود نیست؛ ابتدا Network/RUM trace لازم است. |
| 4 | Debounce جستجو | ALREADY IMPLEMENTED | `public/miniapp/main.js` حدود خط 117 با 240ms و `clearTimeout(searchT)`. |
| 5 | Pagination API | PARTIAL | بیشتر لیست‌های Feed/DM/کامنت/اعلان از صفحات محدود یا before cursor استفاده می‌کنند؛ Explore هنوز `skip(offset)` دارد و Search کاربر تا 200 سند واکشی و 30 نتیجه برمی‌گرداند. Explore برای حجم بالا بهتر است Cursor شود. |
| 6 | CDN | PARTIAL | فایل‌های استاتیک از Vercel ارائه می‌شوند؛ رسانه‌های کاربر private شده‌اند. افزودن CDN دوم بدون اندازه‌گیری توجیه ندارد. |
| 7 | Background Job Queues | IMPLEMENTED / PARTIAL OPS | صف‌های پایدار و Lease برای Inbox، Broadcast، Jeton و Match Delivery وجود دارد؛ زمان بازیابی بعضی کارها هنوز وابسته به Cron/ترافیک است. |
| 8 | N+1 Query elimination | CONFIRMED GAP | N+1 در Explore و DM Overview در کد واقعی دیده شد؛ A-04. اصلاح لازم است، اما در این نسخه به‌علت نبود تست معتبر اجرا نشد. |
| 9 | Gzip/Brotli | NOT APPLICABLE TO APP CODE | فشرده‌سازی باید از تنظیمات/پلتفرم Vercel بررسی شود؛ Middleware جداگانه اضافه نشود. از محیط واقعی تأیید نشده است. |
| 10 | Redis Cache | DEFER | نیاز اندازه‌گیری‌شده‌ای برای Redis ثابت نشده؛ سرویس جدید هزینه و پیچیدگی Consistency اضافه می‌کند. |
| 11 | حذف Dependency بلااستفاده | DEFER | ابزار یا خروجی معتبر برای اثبات بلااستفاده بودن پکیج‌ها اجرا نشد؛ حذف حدسی انجام نشود. |
| 12 | Timeout برای APIها | PARTIAL | Mongo connection/selection/wait queue timeout و `fetchWithTimeout`/Telegram timeout وجود دارد؛ پوشش همهٔ مسیرهای بیرونی و رفتار Retry باید با تست بررسی شود. |
| 13 | AI Streaming | NOT APPLICABLE | جریان اصلی محصول پاسخ LLM استریم‌شونده ندارد. |
| 14 | به‌روزرسانی Dependency امنیتی | NOT VERIFIED | گزارش 1.29.6 از به‌روزرسانی `@vercel/functions` می‌گوید؛ `npm audit` برای این آرشیو در محیط حاضر اجرا نشد. وضعیت Advisory جاری نامشخص است. |
| 15 | Lazy Loading تصاویر | PARTIAL | `NG.img` پارامتر lazy را به `loading="lazy"` تبدیل می‌کند؛ فقط فراخوان‌هایی که پارامتر را فعال کنند از آن استفاده می‌کنند. |
| 16 | درخواست‌های موازی امن | PARTIAL | مواردی از `Promise.all` استفاده می‌کنند، اما کنترل سقف هم‌زمانی سراسری یا بررسی مستقل همهٔ Promiseها وجود ندارد. |
| 17 | بهینه‌سازی Indexها | PARTIAL / NOT MEASURED | 41 محل `createIndex/createIndexes` پیدا شد؛ اسکریپت Explain فقط چند Query را پوشش می‌دهد و در این اجرا روی Atlas/Staging اجرا نشد. |
| 18 | OpenTelemetry | DEFER | مانیتورینگ و Metrics ساده وجود دارد؛ Tracing توزیع‌شده نیاز اندازه‌گیری هزینه و سازگاری Vercel دارد. |
| 19 | تطبیق Region سرور و DB | NOT VERIFIED | از سورس نمی‌توان Region پروژهٔ Vercel یا MongoDB Atlas را فهمید؛ مالک باید پنل‌ها را بررسی کند. |
| 20 | SSR / SSG | NOT APPLICABLE | Mini App فعلی HTML/CSS/JS ایستا است؛ مهاجرت Framework صرفاً برای SSR/SSG توجیه ندارد. |
| 21 | Deferred Script Loading | DEFER | اسکریپت‌های Classic و وابستگی Global `NG` و SDK تلگرام ترتیب اجرای مشخص دارند؛ هر تغییر باید مبتنی بر dependency graph و تست باشد. |
| 22 | Code Splitting تکراری | DUPLICATE OF #1 | پیشنهاد تکراری است؛ همان تصمیم ردیف 1. |
| 23 | Virtual Lists | DEFER | حد فعلی/اندازهٔ لیست‌ها و اسکرول روی دستگاه ضعیف اندازه‌گیری نشده؛ ابتدا پروفایل واقعی لازم است. |
| 24 | ساده‌سازی دکمه‌های UI | DEFER | نیاز UX/تصمیم محصولی دارد؛ هیچ دکمه‌ای بدون تأیید مالک حذف یا تغییر نام نشود. |
| 25 | MongoDB Connection Pool | IMPLEMENTED / CAPACITY UNKNOWN | `src/db/connect.ts` کلاینت را در Warm Instance نگه می‌دارد، `maxPoolSize: 10` و wait/connect timeouts دارد؛ سقف کل اتصال Atlas به تعداد Instanceهای هم‌زمان وابسته و از پنل قابل تأیید است. |
| 26 | کاهش DOM Update | DEFER | Mini App از Vanilla JS است؛ رندر غیرضروری مشخصی با Profiler یا Trace اندازه‌گیری نشده است. |
| 27 | Browser / Service Worker Cache | PARTIAL | `index.html` و `sw.js` دارای Cache-Control no-cache و نسخه‌بندی‌اند؛ استراتژی رسانهٔ خصوصی جداگانه بررسی شود. |
| 28 | Load Balancer | NOT APPLICABLE TO CURRENT ARCHITECTURE | Vercel بار ترافیک را مدیریت می‌کند؛ افزودن NGINX/Kubernetes بدون مهاجرت معماری لازم نیست. |
| 29 | Server Failover | NOT VERIFIED / OWNER CONFIG | باید قابلیت و Tier واقعی Vercel و MongoDB Atlas بررسی شود؛ Failover واقعی در این محیط تست نشده است. |
| 30 | Real User Monitoring | IMPLEMENTED (BASIC) | Mini App یک نمونهٔ عددی بی‌هویت برای زمان Load، اولین API و کلاس Network می‌فرستد؛ `sanitizeRum` و Bucketهای `ops_metrics` داده را تجمیع می‌کنند. پوشش همهٔ تجربه‌ها کامل نیست. |
| 31 | تست موبایل و شبکهٔ ضعیف | DEFER / MANUAL | چک‌لیست `docs/MOBILE_TESTING.md` وجود دارد، ولی NOT VERIFIED است؛ گوشی واقعی و Telegram آزمایش نشده‌اند. |

## 5. ارزیابی Safe Deployment

| بخش | وضعیت | نتیجه |
|---|---|---|
| CI Release Gate | PARTIAL | اسکریپت‌های `verify` و `verify:ci` وجود دارند؛ Workflow خودکار CI در آرشیو پیدا نشد و اجرای کامل Gate در این محیط ممکن نشد. |
| Staging | DOCUMENTED / NOT VERIFIED | `docs/STAGING.md` ایزوله‌سازی Vercel، MongoDB و Telegram را توضیح می‌دهد؛ هیچ Staging واقعی از این محیط ساخته یا آزمایش نشده است. |
| Canary | NOT VERIFIED | Canary وزنی در Vercel/پلن پروژه قابل تأیید نیست؛ مسیر پیشنهادی Preview → Smoke Test → Promote مناسب‌تر است. |
| Health Check | PARTIAL | `/api/health` فقط GET/HEAD را می‌پذیرد، `no-store` دارد و متن خطای Mongo را عمومی نمی‌کند؛ بااین‌حال نام Booleanهای وجود `BOT_TOKEN`، `WEBHOOK_SECRET` و `MONGODB_URI` را عمومی نشان می‌دهد. مقدار Secret افشا نمی‌شود، اما می‌توان حضور متغیرها را استنباط کرد. |
| Monitoring / Alerting | IMPLEMENTED / NOT VERIFIED | `/monitor` و Metrics/Alertها در سورس موجودند؛ ارسال واقعی هشدار و دقت آن‌ها در سرویس زنده بررسی نشده است. |
| MongoDB Backup | DOCUMENTED / NOT VERIFIED | Runbook به Atlas Backup و Snapshot اشاره دارد؛ وضعیت فعال بودن Backup و Retention به پنل Atlas وابسته است. |
| Restore Drill | NOT PERFORMED | `BACKUP_RESTORE.md` صریحاً می‌گوید Restore اجرا نشده؛ باید در کلاستر Staging جداگانه تمرین شود. |
| Code Rollback | DOCUMENTED | برگشت به Deployment قبلی Vercel مستند است؛ Rollback کد، دادهٔ دیتابیس را برنمی‌گرداند. |
| Database Migration Rollback | PARTIAL | تغییرات additive و backward-compatible در گزارش‌ها توصیف شده‌اند؛ برای هر Migration جدید باید plan/backup/rollback جداگانه ثبت شود. |

در `vercel.json` دو Cron روزانه دیده می‌شود (`0 0 * * *` و `0 1 * * *`). این زمان‌بندی به‌تنهایی معادل اجرای هر دقیقه/بازیابی سریع نیست. `CRON_SECRET` در Monitoring رصد می‌شود، ولی وضعیت عملیاتی آن از روی ZIP مشخص نیست.

## 6. وضعیت F-01 تا F-25

| شناسه | وضعیت مستقل در v1.29.7 | نتیجه |
|---|---|---|
| F-01 | BLOCKED | سیاست نمایش/دسترسی محتوای اجتماعی بین رده‌های سنی تصمیم مالک می‌خواهد. هیچ تغییری اعمال نشود. |
| F-02 | PARTIAL | کنترل سن/Block/ban و تراکنش وجود دارد؛ اما Snapshot Transaction تغییر هم‌زمان در سند دیگر را الزاماً متعارض نمی‌کند و ارسال Telegram پس از Commit است؛ پنجرهٔ TOCTOU باقی است. |
| F-03 | PARTIAL | `safeLog.ts` کد و پیام ثابت دارد، اما فهرست استفاده کامل نیست و بعضی مسیرها هنوز `console.error` با Message/Exception دارند. گزارش به کانال لاگ هم پیاده نشده است. |
| F-04 | BLOCKED — STAKES OFF | `STAKE_SWITCH.enabled` برابر false است و ساخت/Join بازی با Stake جدید رد می‌شود؛ مسیر `settle()` برای رکوردهای قدیمی باقی است. هیچ شرط‌بندی فعال یا مسیر تسویه‌ای تغییر داده نشود. |
| F-05 | HISTORICALLY FIXED / NOT RE-VERIFIED | گزارش‌های قبلی آن را رفع‌شده می‌دانند؛ در این ممیزی بازآزمایی کامل تمام شاخه‌های دسترسی انجام نشد. |
| F-06 | PARTIAL | Cache رسانهٔ کاربر private است، اما URL signature انقضا ندارد و Cache محلی هنوز می‌تواند رسانهٔ حذف‌شده را مدتی نگه دارد. |
| F-07 | OPEN — P1 | Retry پیام کاربر وجود دارد؛ Claim رسید به کانال لاگ پیش از Send نوشته می‌شود و در توقف ناگهانی/نبود Chat ID می‌تواند برای همیشه جا بماند. |
| F-08 | OPEN — P1 | تغییر سن تأییدشده نشست/Relay قبلی را نمی‌بندد و Relay سن/Block/Ban تازه را قبل از هر پیام بررسی نمی‌کند. |
| F-09 | PARTIALLY FIXED | Lobby و Join کاربر ثبت‌شده سن/Block را کنترل می‌کنند؛ Guest از کنترل Band مستثنا است و تعیین تکلیفش تصمیم مالک می‌خواهد. |
| F-10 | PARTIAL | `reconcile-ledger` فقط گزارش می‌دهد؛ خودکار Balance را اصلاح نمی‌کند. این رفتار درست و باید حفظ شود. |
| F-11 | NOT VERIFIED | Fake Mongo نمی‌تواند رفتار واقعی Replica Set، Transaction Retry، Write Conflict و تراکنش‌های هم‌زمان را ثابت کند. |
| F-12 | OPEN — P1/P2 | N+1 در Explore و DM تأیید شد؛ Explain/Load Test واقعی اجرا نشد. آمادگی برای یک میلیون کاربر اثبات نشده است. |
| F-13 | PARTIAL | صف‌های پایدار و Monitoring وجود دارد؛ زمان‌بندی روزانه و Triggerهای وابسته به ترافیک برای Recovery سریع کافی‌بودنشان ثابت نشده است. |
| F-14 | OPEN — P1 | Mini App Rate Limit در خطای داخلی Fail-open است. |
| F-15 | PARTIAL | بخشی از Raw Errorها با `safeLog` پوشانده شده‌اند؛ مسیرهای خام هنوز در `bot.ts`، `processUpdate.ts` و چند Service دیده می‌شود. |
| F-16 | OPEN | Export/Import در یک `waitUntil` اجرا می‌شود و checkpoint/resume ندارد. Excel پشتیبان کامل دیتابیس نیست. |
| F-17 | BLOCKED | استثنای Staff/Official در `canContact()` باقی است؛ طبق دستور مالک تغییر نمی‌کند. |
| F-18 | PARTIAL | Stars order با Claim تراکنشی و Ledger ID یکتا محافظت می‌شود؛ موارد نامنطبق ثبت و برای بررسی دستی علامت‌گذاری می‌شوند. در `creditStarsPaymentOnce` نتیجهٔ `users.updateOne` از نظر `matchedCount` بررسی نمی‌شود؛ این مسیر باید با تست حذف/ناموجود بودن User بررسی شود. Refund خودکار برای Exceptionها مشاهده نشد. |
| F-19 | PARTIAL | Registry مستقل و اعتبارسنجی نام Action/شناسهٔ ماژول وجود دارد؛ `Object.assign(errors, m.errors)` برخورد کلید خطا بین ماژول‌ها را بی‌صدا بازنویسی می‌کند. اکنون فقط Backgammon ثبت شده، پس برخورد فعلی ثابت نشده؛ برای افزودن بازی باید duplicate error key رد شود. |
| F-20 | PARTIAL / HISTORICALLY HARDENED | Health no-store و GET/HEAD است و Error خام نمی‌دهد؛ Boolean حضور متغیرهای محیطی هنوز عمومی است. |
| F-21 | NOT VERIFIED | زمان اجرای Seed در این محیط قابل اندازه‌گیری نبود؛ محدودیت Execution Time باید در Staging/Vercel واقعی بررسی شود. |
| F-22 | PARTIAL | Callbackهای جدید از `cbId` مبهم استفاده می‌کنند؛ پیام‌های قدیمی نسخهٔ 1.29.3 که قبلاً ارسال شده‌اند، تا اولین فشردن دکمه و Upgrade تنبل، ممکن است ID فرستنده را در Callback Data نگه دارند. پیام‌های قدیمیِ فشرده‌نشده قابل اصلاح انبوه نیستند چون message_id پیام اطلاع‌رسانی ذخیره نشده است. |
| F-23 | FIXED IN SOURCE | `miniOnboarding.ts` پس از تکمیل واقعی Onboarding، `resumePendingAnonForUser()` را فراخوانی می‌کند؛ مسیر Lease و کنترل مجدد در ادامه وجود دارد. تست واقعی Telegram/DB انجام نشده است. |
| F-24 | PARTIALLY FIXED | Lease، Token، سقف تلاش، انقضا و `completePendingWithFlow()` تراکنشی وجود دارند. Crash بعد از ساخت Flow و قبل از ارسال Prompt می‌تواند Flow موجود ولی Prompt تحویل‌نشده باقی بگذارد؛ Recovery به رخداد بعدی کاربر وابسته است. |
| F-25 | FIXED IN SOURCE | `mayWriteNow()` هر دو کاربر را تازه از DB می‌خواند و اگر هرکدام `banned` باشند رد می‌کند. تست واقعی دیتابیس/Telegram اجرا نشده است. |

## 7. تصمیم‌های مالک که نباید خودکار گرفته شوند

1. F-01: سیاست سطح دسترسی محتوای اجتماعی بین گروه‌های سنی.
2. F-17: هر تغییری در استثنای Staff/Official — فعلاً ممنوع.
3. F-04: هرگونه فعال‌سازی Stake/Wager یا تغییر Settlement — فعلاً ممنوع؛ Stakes خاموش بماند.
4. Guest در Lobby/Join تخته‌نرد.
5. سیاست انقضای امضای Media و اثر آن بر لینک‌های اشتراک‌گذاری قدیمی.
6. سیاست پایان نشست فعال هنگام تغییر Band سن.
7. تعیین تکلیف Refund دستی/خودکار برای پرداخت Stars استثنایی.

## 8. اقدامات پیشنهادی به ترتیب اجرا

1. اصلاح F-14 با fail-closed کنترل‌شده و تست 429/503/DB-failure؛ قبل از تغییر، رفتار availability تعریف شود.
2. طراحی Outbox مستقل و Lease/Retry برای رسید کانال لاگ واریز؛ تست Crash قبل/بعد از Telegram Send و Deduplication.
3. طراحی پایان نشست اتمیک هنگام تغییر Band و بررسی مجدد وضعیت مجاز بودن Relay قبل از ارسال؛ سیاست بازپرداخت و اعلان باید مشخص باشد.
4. Batch کردن Queryهای Explore و DM Overview؛ اضافه‌کردن تست تعداد Query و Benchmark واقعی روی Staging.
5. اصلاح برخورد Error Codeهای Registry و تکمیل Safe Logging با حفظ Redaction.
6. تکمیل بررسی Transaction/Stars با Replica Set واقعی و بررسی `matchedCount` پیش از تأیید اعتباردهی.
7. ایجاد CI Workflow واقعی پس از مشخص شدن Provider؛ اسکریپت `verify:ci` اکنون موجود است.
8. اجرای Staging ایزوله، Smoke Test، Mobile Test، Explain، Reconciliation و Restore Drill.
9. پس از ثبت نتایج، ارزیابی مجدد Cache expiry، Cursor pagination و Virtualization بر اساس RUM و بار واقعی.

## 9. خروجی این ممیزی

- نسخهٔ سورس: بدون تغییر.
- فایل اضافه‌شده: `docs/INDEPENDENT_AUDIT_v1.29.7.md`.
- هیچ دیتابیس، بات، Secret، DNS، Deployment یا تنظیم Production تغییر داده نشد.
- هیچ Migration اجرا نشد.
- هیچ تستی به‌عنوان PASS اعلام نشد مگر آنکه همین‌جا واقعاً اجرا شده باشد.

**شرط شروع Patch بعدی:** نصب کامل وابستگی‌ها، اجرای کامل `npm run verify:ci`، و در موارد نیازمند تراکنش/کارایی، داشتن Staging واقعی جدا از Production. هیچ‌کدام از این شرط‌ها با صرفاً موفق شدن Mock Test جایگزین نمی‌شود.
