# v1.30.0 — notes (English names + inline game invite)

Tests are MOCK tests (fake MongoDB / Telegram); nothing was run against real Mongo, Telegram or Vercel.

## Behaviour
- Names: Latin letters + single spaces, 1..32. Old non-English names of finished accounts are stopped by `enforceEnglishName` (bot middleware after `resumeIfBroken`); exempt: owner, admins, seed/official, banned, people inside a running chat. The Mini App has no separate gate.
- Inline invite: `inline_query` → one result per game with `invite` in the registry; button = url `t.me/<bot>?start=ig_<token>` (web_app buttons are not allowed in inline results). Token = HMAC(WEBHOOK_SECRET, host:game:day) cut to 16 chars; doc in `game_invites` (24 h, TTL index).
- Entry: forced-join → name → age → «ورود به بازی». Mini App action `game_invite` (guest-allowed): the HOST opens the table, others sit down; `waiting_host` (409) while the host has not entered.
- Age band F-09 / F-17 untouched; guest entrants must have an age and pass `canContact` from fresh reads.

## Limits
- The table is created when the HOST presses his own button (no `chosen_inline_result` feedback is used).
- All inline results of one query use the single `GAME_SHARE_PHOTO` photo (per-game photos not built); only backgammon is in the registry.
- Mini App sections for not-yet-registered people show a «complete your info» card; their data stays closed server-side.

## Owner steps
1. BotFather → `/setinline` (placeholder text).  2. `npm run set-webhook` again (adds `inline_query`).  3. deploy.
Rollback: redeploy v1.29.8; the extra fields (`inviteFlow`, `nicknameFixPending`, collection `game_invites`) are ignored by the old code.
