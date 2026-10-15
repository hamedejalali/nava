# NAVA v1.16.1 — گزارش ممیزی، رفع باگ و اعتبارسنجی

تاریخ: ۲۰۲۶-۱۰-۱۲ · مبنا: v1.16.0 · همه‌ی تست‌ها روی **Mongo و Telegram جعلی (in-memory)** اجرا شده‌اند؛ هیچ داده‌ی واقعی، توکن یا دیتابیس تولید لمس نشده است.

## A) ریشه‌ی مشکل /start برای کاربران غیرمالک

**قطعی (با تست ثابت شد):**
1. صفحه‌ی خوش‌آمد سه دکمه‌ی زبان دارد (فارسی/English/العربية). متن‌های `en` و `ar` در `src/i18n/locales/{en,ar}.ts` عمداً `undefined` هستند (ممنوعیت «ترکیب زبان»). انتخاب هر کدام در `showGenderStep` به `requireLocked` می‌رسید → در dev/test `MissingTranslationError`، در production متن «…» و دکمه‌های «…» = بن‌بست کامل. مالک/ادمین هرگز از ثبت‌نام عبور نمی‌کنند، پس فقط کاربران عادی این را می‌بینند — دقیقاً علامت «مالک کار می‌کند، بقیه نه».
2. طراحی webhook: خطای قطعی در handler → HTTP 500 → کاربر هیچ پاسخی نمی‌گیرد و تلگرام همان update را تکرار می‌کند.
3. دو خطر کوچک‌تر (رفع شد): اولین /start همزمان با E11000 روی `_id` خطا می‌داد؛ شکست `getAllAdminIds()` در اعلان «کاربر جدید» یک unhandled rejection می‌ساخت که در Node می‌تواند instance سرورلس را وسط درخواست کاربر بکشد.

**رفع:** `isLanguageReady()` در `src/i18n/index.ts`؛ در `language.ts` انتخاب زبان آماده‌نشده فقط alert می‌دهد و ذخیره نمی‌کند؛ /start کاربرانی که قبلاً روی en/ar گیر کرده‌اند صفحه‌ی انتخاب زبان را دوباره نشان می‌دهد و پیشرفتشان حفظ می‌شود (بعد از انتخاب فارسی در همان مرحله ادامه می‌دهند).

**ثابت‌نشده (نیاز به لاگ/اطلاعات تولید، از اینجا قابل بررسی نیست):** اگر در تولید حتی با انتخاب «فارسی» هم گیر می‌کنید، علت یکی از اینهاست و با هیچ تستی اینجا قابل بازتولید نبود: (الف) MongoDB بدون replica-set (تراکنش در `grantInitialBalanceIfNeeded` برای هر کاربر **جدید** اجرا می‌شود؛ مالک از قبل ثبت شده)، (ب) ایندکس قدیمی/متعارض روی `users` (خطای ساخت ایندکس‌ها فقط لاگ می‌شود)، (ج) تنظیم نادرست force-join/کانال، (د) webhook با secret اشتباه یا آدرس قدیمی (`npm run webhook-info` را اجرا کنید و `last_error_message` را بفرستید؛ لاگ Vercel برای `[nava:webhook] handleUpdate failed`).

## B) گزارش باگ‌ها

| ID | شدت | وضعیت | محل | ریشه | رفع | تست |
|---|---|---|---|---|---|---|
| NAV-01 | بالا | رفع‌شده/قطعی | `onboarding/language.ts`, `i18n/index.ts` | زبان بدون متن قابل انتخاب بود | بالا (A) | start-onboarding 16,17 |
| NAV-02 | متوسط | رفع‌شده/قطعی | `db/models/user.ts` | E11000 روی `_id` در upsert همزمان تلاش مجدد نمی‌شد | retry | start-onboarding 18 |
| NAV-03 | متوسط | رفع‌شده/قطعی | `bot.ts` | `.then` بدون `.catch` | `.catch` | start-onboarding 19 (بدون fix شکست خورد) |
| NAV-04 | بالا | رفع‌شده | `api/cron/expire-searches.ts`, `matchQueue.ts` | کرون با `_id` حذف می‌کرد؛ جستجوی تازه‌ی همان کاربر پاک و اعلان اشتباه می‌رفت؛ `timeoutNotified` هرگز نوشته نمی‌شد؛ دو کرون همزمان = اعلان تکراری؛ شکست send = اعلان از دست رفته | lease اتمیک روی (`_id`,`createdAt`,`expiresAt`)، حذف دقیق همان سند، خطای موقت=نگه‌داشتن، دائمی=پاکسازی، حلقه‌ی ایمن به‌ازای هر رکورد، `limit(200)` | expire-searches A1–A9 |
| NAV-05 | متوسط | رفع‌شده | `features/matching/search.ts` | شمارش‌معکوس جستجوی قبلی جستجوی جدید همان کاربر را claim می‌کرد | فیلتر `createdAt ≤ startedAt` + احترام به lease | A8, A9 |
| NAV-06 | متوسط | رفع‌شده | `services/nava/stories.ts` | batch ۲۰۰تایی بدون sort؛ ۲۰۰ استوری هایلایت‌شده جلوی بقیه را می‌گرفت | صفحه‌بندی keyset oldest-first، یک query هایلایت برای هر صفحه، بازبینی نهایی قبل از حذف، حد `maxPages`، ایندکس `storyIds` | story-cleanup B1–B3 |
| NAV-07 | بالا (مالی) | رفع‌شده | `features/payments/index.ts` | تحویل Relic از لیست قیمت **فعلی** با index؛ تغییر قیمت بعد از فاکتور = پول گرفته‌شده بدون Relic (فقط console.error)؛ ارز بررسی نمی‌شد | سفارش ماندگار (`stars_orders`) در لحظه‌ی فاکتور، اعتبار از همان سفارش، اعتبارسنجی ارز/مبلغ/charge id، استثناها در `stars_payment_exceptions` + اعلان مالک، سازگاری با payload قدیمی | stars-payments C1–C7 |
| NAV-08 | متوسط | رفع‌شده | `nava/posts.ts`, `miniappSocial.ts`, `matching/profile.ts` | سند لایک/کامنت و شمارنده دو نوشتن جدا؛ کرش/همزمانی = شمارنده ناسازگار (حتی دائمی) | تراکنش واحد (`db/tx.ts`)؛ بدون یتیم برای پست حذف‌شده | social-counters E1–E8 |
| NAV-09 | متوسط | رفع‌شده | `nava/search.ts` `explore()` | یک query با `limit(page*6)`؛ کاربر پرپست بقیه را از کاشی‌ها حذف می‌کرد | یک query ایندکس‌دار `limit(1)` به‌ازای هر کاربر صفحه (حداکثر ۲۴) | F1 |
| NAV-10 | متوسط (مالی) | رفع‌شده | `db/models/relic.ts` `transferRelicOnce` | گیرنده‌ی ناموجود: بدهکاری فرستنده + ردیف credit ledger بدون افزایش موجودی | abort/rollback → `invalid` | S1 |
| NAV-11 | پایین | رفع‌شده | webhook/cron | مقایسه‌ی secret با `===` | `timingSafeEqual` | (بازبینی کد) |
| NAV-12 | پایین | رفع‌شده | package.json | `@scure/bip39` بازمانده‌ی کیف پول، بدون استفاده | حذف از package.json و lock | کامپایل/تست |

**D (کرون/TTL/Vercel):** `vercel.json` روزانه است و با محدودیت Hobby سازگار؛ ثابت‌نگه‌داشته شد (زیرساخت جدید اختراع نشد). مسیر اصلی اعلان تایم‌اوت شمارش‌معکوس داخل خود webhook است؛ کرون فقط جبران است و چون TTL ایندکس `expiresAt` رکورد را معمولاً ≤۶۰ ثانیه پس از انقضا حذف می‌کند، رکوردی که TTL قبل از کرون برداشته دیگر قابل بازیابی نیست (**ریسک باقی‌مانده، تغییر ایندکس TTL عمداً انجام نشد چون `createIndex` با گزینه‌ی متفاوت روی ایندکس موجود خطا می‌دهد**).

### ریسک‌های نظری / ثابت‌نشده (تأییدنشده)
- `creditLedgerOnce` در صورت نبودن سند کاربر ردیف ledger می‌نویسد بی‌آنکه موجودی عوض شود؛ تغییرش روی جریان‌های ثبت‌نام اثر دارد (ممکن است ثبت‌نام را بشکند) و عمداً دست نخورد. در عمل کاربر همیشه قبلاً ساخته شده.
- ثبت‌نام: آپدیتی که deterministic خطا بدهد تا تلگرام آن را رها کند تکرار می‌شود (طراحی فعلی عمدی است).
- `npm audit --omit=dev`: ۲ مورد moderate (`uuid <11.1.1` از طریق `exceljs`، فقط با پارامتر `buf` در v3/v5/v6 — exceljs از v4 استفاده می‌کند؛ نظری). رفع نیاز به ارتقای major دارد و انجام نشد.
- ممیزی دستی احراز هویت `api/miniapp.ts`: همه‌ی ورودی‌ها قبل از ورود به فیلتر Mongo نوع‌سنجی می‌شوند (`isAnonId`, `isId`, typeof) — تزریق عملگر مشاهده نشد؛ اندازه‌ی تصویر محدود (۳MB)؛ تصاویر با امضا. بازبینی خودکار جامع وجود ندارد (یک زیرعامل ممیزی به‌خاطر محدودیت سرویس نیمه‌کاره ماند؛ بررسی‌ها دستی و محدود به فایل‌های نام‌برده انجام شد). همه‌ی handlerهای `features/admin/*` شرط `isAdmin/isOwner` دارند (تست ۱۱: کاربر عادی پنل نمی‌گیرد).
- Relic/mining: مسیرهای debit/credit/transfer/gift/chat-cost همگی تراکنشی با guard `$gte` و شناسه‌ی ledger قطعی‌اند (بازبینی کد + تست‌های موجود). «Mining» جداگانه‌ای در این ریپو وجود ندارد (کیف پول/ماینینگ جدا شده).

## C) فایل‌های تغییرکرده
`src/i18n/index.ts`, `src/features/onboarding/language.ts`, `src/db/models/user.ts`, `src/bot.ts`, `api/cron/expire-searches.ts`, `src/db/models/matchQueue.ts`, `src/features/matching/search.ts`, `src/services/nava/stories.ts`, `src/services/miniappSocial.ts` (ایندکس storyIds + لایک تراکنشی), `src/features/payments/index.ts`, `src/db/models/starsOrder.ts` (جدید), `src/db/tx.ts` (جدید), `src/services/nava/posts.ts`, `src/features/matching/profile.ts`, `src/services/nava/search.ts`, `src/db/models/relic.ts`, `src/utils/secureCompare.ts` (جدید), `api/webhook.ts`, `api/cron/process-broadcasts.ts`, package.json/lock (حذف bip39 + نسخه), `src/config/version.ts`, CHANGELOG.md. تست‌های جدید: `start-onboarding`, `expire-searches`, `story-cleanup`, `stars-payments`, `social-counters`. هیچ route/فیلد/env تغییر نام نداد؛ **قابلیتی حذف نشد**. رفتار تغییرکرده‌ی قابل‌مشاهده: انتخاب English/العربية الان alert می‌دهد (به‌جای صفحه‌ی خالی)؛ مجموعه‌های جدید Mongo: `stars_orders`, `stars_payment_exceptions` (خودکار ساخته می‌شوند).

## D) گزارش تست (اجرا شده، روی کپی تمیز با `npm ci`)
| دستور | نتیجه |
|---|---|
| `npm ci` | موفق (277 بسته) |
| `npx tsc --noEmit` | موفق، بدون خطا |
| `npm run build` (`tsc -p`) | موفق |
| `npm test` | **140 تست، 140 موفق، 0 شکست، 0 skip** |
| `npm audit --omit=dev` | 2 moderate (uuid←exceljs)، رفع‌نشده، شرح بالا |
| lint | اسکریپت lint در پروژه وجود ندارد — اجرا نشد |
| Mongo واقعی / تلگرام واقعی / استقرار Vercel | **اجرا نشد** (محیط sandbox mongod ندارد و شبکه محدود است) |

محدودیت‌ها: رفتار تراکنش/ایندکس/TTL/write-conflict روی Mongo واقعی فقط با شبیه‌ساز تست شده است؛ پیش از تولید مرحله‌ی پیش‌نمایش (Preview) را اجرا کنید.

## F) چک‌لیست استقرار
1. `npm ci && npx tsc --noEmit && npm test` روی همین zip.
2. Deploy به Preview یا (اگر ندارید) در ساعت کم‌ترافیک؛ `GET /api/health` باید `ok:true` بدهد.
3. `npm run webhook-info` → `pending_update_count` و `last_error_message` را بررسی کنید.
4. تست /start با یک حساب تلگرام جدید (غیرمالک، همان که ادمین نیست): /start → باید صفحه‌ی زبان بیاید → «فارسی» → جنسیت → سن → استان → شهر → نام مستعار. هم‌چنین یک‌بار «English» را بزنید: باید alert «این زبان هنوز فعال نشده» بیاید. (از حساب دوم/شماره‌ی تست استفاده کنید؛ کاربران واقعی را لمس نکنید. پس از تست می‌توانید از پنل ادمین «ریست کاربر» همان حساب تست را بزنید.)
5. لاگ Vercel را برای `[nava:webhook] handleUpdate failed` و `[payments]` بپایید. پرداخت تأییدنشده‌ی Stars در `stars_payment_exceptions` و پیام مالک دیده می‌شود.
6. هیچ env جدیدی لازم نیست.

## G) ریسک‌های باقی‌مانده
- علت واقعی «/start برای غیرمالک» در **تولید** با داده‌ی تولید اثبات نشده (فقط بن‌بست زبان اثبات شد)، بخش A را ببینید. پروژه را «بدون باگ» نمی‌نامم.
- TTL ایندکس صف می‌تواند رکورد منقضی را قبل از کرون بردارد (کرون فقط پشتیبان است).
- باگ‌های وابسته به Mongo واقعی (write-conflict/ایندکس) فقط شبیه‌سازی شده‌اند.
- ۲ هشدار moderate در npm audit.
- ممیزی امنیتی دستی و نمونه‌ای بود، نه اسکن خودکار کامل؛ بخش‌های `features/matching/*` و `services/nava/*` غیر از موارد نام‌برده خط‌به‌خط بازبینی نشدند.
