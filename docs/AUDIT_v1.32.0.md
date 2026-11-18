# گزارش v1.32.0 — طراحی داخلی ربات

- ماژول‌ها: `src/features/admin/innerDesign.ts`، `src/services/uiApply.ts`، `src/db/models/uiOverrides.ts`، `src/services/emojiSyntax.ts`، `src/services/profileTemplate.ts`، کاتالوگ `src/generated/textCatalog.ts` (اسکریپت `scripts/gen-text-catalog.ts`).
- امنیت: همه‌ی ورودی‌ها (متن، callback، inline) فقط برای مالک؛ برای دیگران بی‌پاسخ.
- F-01/F-17، شرط‌بندی، ولت و ربات‌های دیگر دست نخورد. مایگریشن مخرب ندارد (کالکشن جدید `ui_overrides`).
- تست‌ها MOCK هستند (Mongo/Telegram ساختگی)؛ رفتار واقعی تلگرام (نمایش اینلاین، رنگ دکمه) باید روی ربات واقعی دیده شود.
- محدودیت‌ها: مثل CHANGELOG.
- برگشت: دیپلوی ۱.۳۱.۲؛ کالکشن جدید بی‌اثر می‌ماند.
