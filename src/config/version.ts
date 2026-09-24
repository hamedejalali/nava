/**
 * SINGLE SOURCE OF TRUTH for the bot version.
 *
 * Bump this on EVERY change you ship, together with:
 *   - "version" in package.json
 *   - the newest entry at the top of CHANGELOG.md
 *   - the zip file name (nava-project-v<version>.zip)
 * It is shown on the (do-nothing) version button at the bottom of the
 * admin panel, so you can always see which build is really deployed.
 */
export const BOT_VERSION = "1.1.1";

/** Text on the admin panel's version button. */
export const VERSION_BUTTON_LABEL = `🏷 نسخه ${BOT_VERSION}`;
