import "dotenv/config";

/**
 * Optional: makes the Nava Mini App the bot's "Menu" button (the blue button
 * next to the message box), so users can open it in one tap.
 *   npm run set-menu-button          -> sets it
 *   npm run set-menu-button -- reset -> back to the default commands menu
 * Uses NAVA_MINIAPP_URL, or PUBLIC_URL + "/miniapp/".
 */
const token = process.env.BOT_TOKEN;
const explicit = process.env.NAVA_MINIAPP_URL?.trim();
const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
const url = explicit || (base ? `${base}/miniapp/` : undefined);

if (!token) {
  console.error("Missing BOT_TOKEN in your .env file.");
  process.exit(1);
}

const reset = process.argv.includes("reset");
if (!reset && !url) {
  console.error("Missing NAVA_MINIAPP_URL / PUBLIC_URL in your .env file.");
  process.exit(1);
}

const menu_button = reset ? { type: "default" } : { type: "web_app", text: "نوا", web_app: { url } };
const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ menu_button }),
});
const data = (await res.json()) as { ok: boolean; description?: string };
console.log(data.ok ? (reset ? "Menu button reset." : `Menu button set -> ${url}`) : `Failed: ${data.description}`);
