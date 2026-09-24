# Nava Bot — Version 1.1.1

A Persian anonymous chat & matchmaking Telegram bot. Node.js + TypeScript + grammY + MongoDB + Vercel Serverless.

## Contents

1. Requirements
2. Local install
3. Environment variables (full)
4. MongoDB setup
5. BotFather setup
6. Deploying to Vercel
7. Webhook setup
8. Cron setup (important plan limitation)
9. First-time setup after deploy
10. Admin panel guide
11. Architecture & key technical decisions
12. Full testing checklist
13. Known limitations / remaining work
14. Troubleshooting

---

## 1. Requirements

- Node.js 18.18+
- A MongoDB instance (MongoDB Atlas free M0 is enough and supports transactions)
- A bot created via @BotFather
- A Vercel account
- (Optional but recommended) a Sightengine account for image moderation

## 2. Local install

```bash
npm install
cp .env.example .env
```

Fill in `.env` per the next section.

## 3. Environment variables (full)

| Variable | Required? | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | From BotFather |
| `WEBHOOK_SECRET` | ✅ | Any random string (`openssl rand -hex 32`) |
| `PUBLIC_URL` | Local scripts only | Your deployed Vercel URL |
| `MONGODB_URI` | ✅ | Connection string |
| `MONGODB_DB_NAME` | No (default nava) | Database name |
| `CRON_SECRET` | For search-timeout notifications | Vercel sends it automatically as `Authorization: Bearer <value>` |
| `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET` | For image moderation | From sightengine.com |
| `SIGHTENGINE_THRESHOLD` | No (default 0.5) | Risk score (0-1) at/above which an image goes to the admin |
| `STARS_PACKAGES` | No (has a default) | Placeholder prices — the spec never defined real pricing; replace before production |
| `EMOJI_PREMIUM_*` (40+) | No | Premium Emoji IDs; leave empty for a Unicode fallback |
| `ADMIN_IDS` | ✅ | Comma-separated Telegram admin user IDs |

## 4. MongoDB setup

1. Create a cluster (Atlas M0 works — free and a replica set, so transactions work).
2. Create a database user, get the connection string, put it in `MONGODB_URI`.
3. Allow `0.0.0.0/0` network access (Vercel has no fixed IP) or use Atlas's Vercel integration.
4. Indexes are created automatically on first run.

## 5. BotFather setup

- `/newbot`, grab the token
- `/setprivacy` → Disable
- Nothing extra needed for Telegram Stars — `currency: XTR` works automatically

## 6. Deploying to Vercel

1. Push `NAVA_BOT` to a GitHub repository
2. Create a new Vercel project from it
3. Set all variables from section 3 under Project Settings
4. Deploy

## 7. Webhook setup

```bash
npm run set-webhook
npm run webhook-info
npm run delete-webhook
```

## 8. Cron setup (important limitation)

`vercel.json` defines a cron every 2 minutes that notifies users whose search timed out.

**Vercel's free Hobby plan only allows cron jobs once per day.** Options:
- Upgrade to Pro (allows per-minute schedules)
- Or hit `https://<domain>/api/cron/expire-searches` yourself every 1-2 minutes from a free external monitor (e.g. UptimeRobot) with header `Authorization: Bearer <CRON_SECRET>`

## 9. First-time setup after deploy

1. Add your numeric Telegram ID to `ADMIN_IDS` (redeploy)
2. Send `/admin` to the bot
3. "تنظیم کانال جوین اجباری" → add your required channel(s)
4. Set "آیدی پشتیبانی"
5. Optionally edit the default texts from the admin panel

## 10. Admin panel guide (`/admin`)

- Edit guides: general guide text, Guide 1, pinned promo, rules
- Support ID
- Required channels (up to 10)
- Manual Relic adjustment
- Send message: navigation only; broadcast logic is a future prompt

Flagged images (profile or in-chat) are sent to you automatically with approve/reject buttons.

## 11. Architecture & key technical decisions

- No in-memory state: everything lives in MongoDB.
- Everything idempotent via deterministic IDs.
- MongoDB transactions for matchmaking and Relic transfers.
- Anonymous ID (anonId) instead of the real Telegram ID everywhere user-facing.
- Glass buttons use Bot API 9.4's real `style` field.
- City data from sajaddp/list-of-cities-in-Iran (31 provinces, 1,657 cities).

## 12. Full testing checklist

Onboarding:
- [ ] `/start` multiple times in a row
- [ ] Rapid-tap language/gender buttons
- [ ] Invalid age, Persian/Arabic digits
- [ ] Non-Persian nickname
- [ ] A province with many cities (Fars/Isfahan) — pagination

Force Join:
- [ ] Try connecting without joining
- [ ] `/Exempt`
- [ ] Verify after actually joining

Matchmaking & chat:
- [ ] Two accounts, lucky search, should match
- [ ] 1 Relic deducted from both
- [ ] One-sided end chat → other side gets cashback
- [ ] Like a profile (shouldn't double-count)
- [ ] Transfer Relic (invalid/insufficient/valid amounts)
- [ ] Zero balance on a search button

Image moderation:
- [ ] Safe profile photo (auto-approved)
- [ ] Flagged photo (goes to admin)
- [ ] Photo inside an active chat

Stars payment:
- [ ] Buy a package, Relic credited, not double-credited on retry

Admin:
- [ ] Text edits take effect immediately
- [ ] Add/remove/toggle a channel
- [ ] Add/remove Relic

## 13. Known limitations

- Written in a sandbox without internet access — no live testing was performed.
- `STARS_PACKAGES` prices are placeholders.
- Safe chat / chat request / direct message / add contact / block / report / notify-on-end / broadcast buttons are UI-only per the spec's staged approach.
- Referral & profile-completion rewards: architecture only, per explicit spec instruction.
- Premium Wallet: shared-architecture foundation only — full Mini App is a future deliverable per the spec.
- Cron is limited to once/day on Vercel's free plan.

## 14. Troubleshooting

| Issue | Fix |
|---|---|
| Bot doesn't respond | Run `npm run webhook-info`, check `last_error_message` |
| MongoDB transaction error | Needs a replica set (Atlas always is one) |
| Premium emoji not showing | Fill in the real `EMOJI_PREMIUM_*` IDs |
| Moderation not working | Check `SIGHTENGINE_API_USER`/`SECRET` |
| Cron not firing | Hobby plan limitation + check `CRON_SECRET` |
