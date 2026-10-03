import "dotenv/config";

const token = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const publicUrl = process.env.PUBLIC_URL;

if (!token || !secret || !publicUrl) {
  console.error("Missing BOT_TOKEN, WEBHOOK_SECRET, or PUBLIC_URL in your .env file.");
  process.exit(1);
}

const url = `${publicUrl.replace(/\/$/, "")}/api/webhook`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    // pre_checkout_query is REQUIRED for Telegram Stars payments: without it
    // Telegram never delivers the pre-checkout update, the bot can't answer
    // it, and every purchase fails with a timeout.
    // "message_reaction" is REQUIRED for real in-chat reaction mirroring
    // (v1.8.0, src/features/matching/reactions.ts) — without it Telegram
    // never delivers message_reaction updates at all.
    allowed_updates: ["message", "callback_query", "pre_checkout_query", "message_reaction"],
    drop_pending_updates: false,
    // Telegram defaults this to 40 when omitted, and caps in-flight
    // webhook deliveries to this bot at that number — every second a
    // request stays "in progress" (as the search countdown used to, before
    // v1.7.0's waitUntil fix) ate into this same shared budget. Explicit
    // and at Telegram's real maximum for extra headroom as the bot grows.
    max_connections: 100,
  }),
});

const data = (await res.json()) as { ok: boolean; [key: string]: unknown };
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  process.exit(1);
}

console.log(`\nWebhook set to: ${url}`);
