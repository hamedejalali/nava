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
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  process.exit(1);
}

console.log(`\nWebhook set to: ${url}`);
