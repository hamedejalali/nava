import "dotenv/config";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Missing BOT_TOKEN in your .env file.");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
