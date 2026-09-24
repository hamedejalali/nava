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
    allowed_updates: ["message", "callback_query", "pre_checkout_query"],
    drop_pending_updates: false,
  }),
});

const data = (await res.json()) as { ok: boolean; [key: string]: unknown };
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  process.exit(1);
}

console.log(`\nWebhook set to: ${url}`);
