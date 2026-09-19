import "dotenv/config";

const token = process.env.WALLET_BOT_TOKEN;
const secret = process.env.WALLET_WEBHOOK_SECRET;
const publicUrl = process.env.PUBLIC_URL;

if (!token || !secret || !publicUrl) {
  console.error("Missing WALLET_BOT_TOKEN, WALLET_WEBHOOK_SECRET, or PUBLIC_URL in your .env file.");
  process.exit(1);
}

const url = `${publicUrl.replace(/\/$/, "")}/api/wallet-webhook`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  }),
});

const data = (await res.json()) as { ok: boolean; [key: string]: unknown };
console.log(JSON.stringify(data, null, 2));

if (!data.ok) {
  process.exit(1);
}

console.log(`\nWallet bot webhook set to: ${url}`);
