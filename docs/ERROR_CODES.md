# Error codes (v1.29.6)

Every caught-and-logged infrastructure error is printed as ONE line by `logError()` (`src/utils/safeLog.ts`):

    [CODE] static description :: ErrorClassName[shortCode]

Never the error message, stack, request parameters or cause (they can contain user text, host names or tokens).
Search the Vercel runtime logs for the code. Codes are stable; never reuse one.

| Code | Meaning | First thing to check |
|---|---|---|
| MG-DB-001 | MongoDB connection attempt failed | Atlas status, IP/network access list, `MONGODB_URI` |
| MG-DB-002 | MongoDB ping failed (`/api/health`) | same as above |
| MG-WH-001 | webhook: cold-start bot construction failed | `BOT_TOKEN` env var |
| MG-WH-002 | webhook secret unreadable | `WEBHOOK_SECRET` env var |
| MG-WH-003 | `bot.init()` failed | Telegram reachability, `BOT_TOKEN` validity |
| MG-BOT-001 | bot index setup failed (retried next cold start) | MongoDB permissions |
| MG-MA-001 | Mini App index setup failed (retried next request) | MongoDB permissions |
| MG-VF-001 | verify sample photo could not be sent | the sample file_id belongs to another bot |
| MG-VF-002 | verify notification photo failed (text fallback used) | user blocked the bot |
| MG-CR-001 | chat request could not be delivered | user blocked the bot |
| MG-PR-001 | profile photo could not be sent (text fallback used) | stale `file_id` |
| MG-PR-002 | profile-reveal notification failed | user blocked the bot |
| MG-AD-001 | admin channel `getChat` failed | bot is not in the channel |
| MG-BK-001 | backup DM to admin failed | admin never started the bot |
| MG-BK-002 | backup to the backup channel failed | bot is not an admin of the channel |
| MG-BK-003 | export failed | MongoDB load / function timeout |
| MG-BK-004 | import failed | file format / Telegram download |
| MG-RG-001 | reaction-gate check failed (the user is let through) | Telegram API status |
| MG-IN-001 | invite banner photo could not be sent | stale `file_id` |

Other log lines that are intentionally NOT coded (already print only `err.name`, never a message): `[monitor] …`, `[cron] … failed`, `[miniapp] rate limiter unavailable`.
