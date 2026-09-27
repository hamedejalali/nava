import { createHmac } from "node:crypto";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

/**
 * Validates Telegram's `initData` string (sent by the Mini App's
 * `Telegram.WebApp.initData`) against the bot token it was issued for.
 * This is the ONLY trustworthy way to know which real Telegram user is
 * calling a Mini App backend endpoint — never trust a user id the
 * frontend sends directly, since that's trivially spoofable by anyone
 * calling the API directly instead of through the Mini App.
 *
 * Returns the verified user, or null if the signature is invalid/expired.
 */
export function verifyTelegramWebAppInitData(initData: string, botToken: string, maxAgeSeconds = 3600): TelegramWebAppUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) return null;

    const authDate = Number(params.get("auth_date"));
    if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

    const userJson = params.get("user");
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    if (typeof user?.id !== "number") return null;

    return user as TelegramWebAppUser;
  } catch {
    return null;
  }
}
