# v1.29.7 — change record (request of 2026-11-09)

Scope: only what the owner asked for. All tests are MOCK tests (fake Mongo/Telegram); nothing was verified against the real bot.
1. Wallet monitor alert: was fired by any single failed sync (incl. a lone timeout) and said one unexplained sentence. Now: `errorStreak` in `wallet_sync`; alert only after ≥3 failed runs in a row, last failure < 6 h ago, no success for 30 min; text = cause / effect / what to do (`walletSyncText`). Tests U1, U2, W-streak.
2. «🪙 مدیریت ژتون» options moved to the admin reply keyboard (labels in `ADMIN_MENU_LABELS`, owner only; back = «↩️ بازگشت به پنل» so the keyboard is classified as an admin keyboard). Old inline callbacks still work for messages already sent. Tests J1–J4 (adapted), U4, U5.
3. Lists as glass inline buttons: user list and verified-user list rows open the profile card (`admin:user:view:<id>`, admin only); the profile card shows only ban OR unban; channel toggle buttons carry the channel name. Tests U6–U8.
4. Red «❌ لغو» reply button added to two prompts that lacked it (official account, badges). Test U9; `v122-app` B1 adapted (the panel keyboard is now restored after the picker).
Not done / still open: the request «review everything from the start» is not something a single pass can certify — this release only fixes what was found while reviewing the admin flows; the F-xx list in `AUDIT_v1.29.6.md` is unchanged (F-01, F-17, F-04 still BLOCKED). Other lists (gifts, seeds, shop, moderators) already use glass buttons and were not changed.
