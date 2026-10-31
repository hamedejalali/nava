/**
 * SINGLE SOURCE OF TRUTH for the bot version.
 *
 * Bump this on EVERY change you ship, together with:
 *   - "version" in package.json
 *   - the newest entry at the top of CHANGELOG.md
 *   - the zip file name (nava-project-v<version>.zip)
 *   - `NG.VER` in public/miniapp/core.js, `VERSION` in public/miniapp/sw.js and the ?v= in public/miniapp/index.html
 *     (the mini-app compares NG.VER with this file's version and reloads itself when they differ)
 * It is shown on the (do-nothing) version button at the bottom of the
 * admin panel, so you can always see which build is really deployed.
 */
export const BOT_VERSION = "1.27.2";

/** Text on the admin panel's version button. */
export const VERSION_BUTTON_LABEL = `🏷 نسخه ${BOT_VERSION}`;

/**
 * Revision of the reply keyboards (main menu / admin panel). Telegram keeps the OLD keyboard on a user's screen until the bot
 * sends a new one, so after a release that renamed/moved buttons people would be stuck with dead buttons until /start.
 * Bump this ONLY when a keyboard's buttons change: every user then gets the fresh keyboard once, automatically, on their next tap/message.
 */
export const KEYBOARD_REV = "1.27";
