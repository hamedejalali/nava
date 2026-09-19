/**
 * Centralized environment variable access.
 *
 * IMPORTANT: This module must be safe to import in a serverless function.
 * It validates REQUIRED variables eagerly (fail fast, clear error) and
 * treats OPTIONAL variables (like Premium Emoji IDs that are not configured
 * yet) as safely-missing values rather than crashing the whole bot.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `[env] Missing required environment variable "${name}". ` +
        `Set it in .env (local) or in Vercel Project Settings -> Environment Variables.`
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") return undefined;
  return value;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",

  get BOT_TOKEN() {
    return required("BOT_TOKEN");
  },
  get WEBHOOK_SECRET() {
    return required("WEBHOOK_SECRET");
  },
  get MONGODB_URI() {
    return required("MONGODB_URI");
  },
  get MONGODB_DB_NAME() {
    return process.env.MONGODB_DB_NAME || "nava";
  },

  get CRON_SECRET() {
    return optional("CRON_SECRET");
  },
  get WALLET_BOT_TOKEN() {
    return optional("WALLET_BOT_TOKEN");
  },
  get WALLET_WEBHOOK_SECRET() {
    return optional("WALLET_WEBHOOK_SECRET");
  },
  get WALLET_MINIAPP_URL() {
    return optional("WALLET_MINIAPP_URL");
  },

  /** Optional file_id (or public https URL) of a default profile photo
   *  shown for a user of that gender who hasn't uploaded their own photo
   *  yet. If unset, profiles simply show text with no photo (never a
   *  crash) — set these once you have a real image to use, e.g. by
   *  sending it to the bot once and reading the file_id from the log. */
  get DEFAULT_PHOTO_MALE() {
    return optional("DEFAULT_PHOTO_MALE");
  },
  get DEFAULT_PHOTO_FEMALE() {
    return optional("DEFAULT_PHOTO_FEMALE");
  },
  get INVITE_BANNER_PHOTO() {
    return optional("INVITE_BANNER_PHOTO");
  },
  get VERIFY_PHOTOS(): string[] {
    return [1, 2, 3, 4, 5].map((n) => optional(`VERIFY_PHOTO_${n}`)).filter((v): v is string => !!v);
  },
  get VERIFY_APPROVED_PHOTO() {
    return optional("VERIFY_APPROVED_PHOTO");
  },
  get VERIFY_REJECTED_PHOTO() {
    return optional("VERIFY_REJECTED_PHOTO");
  },

  sightengine: {
    get apiUser() {
      return optional("SIGHTENGINE_API_USER");
    },
    get apiSecret() {
      return optional("SIGHTENGINE_API_SECRET");
    },
    get threshold(): number {
      const raw = optional("SIGHTENGINE_THRESHOLD");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : 0.5;
    },
  },

  /** Telegram Stars packages (stars -> Relic). Configurable via env since
   *  the project spec never defined actual prices — the fallback below is
   *  a clearly-placeholder default; REVIEW BEFORE PRODUCTION. Format:
   *  '[{"stars":50,"relic":10},{"stars":100,"relic":25}]' */
  get starsPackages(): { stars: number; relic: number }[] {
    const raw = optional("STARS_PACKAGES");
    if (!raw) {
      return [
        { stars: 50, relic: 10 },
        { stars: 100, relic: 25 },
        { stars: 250, relic: 75 },
      ];
    }
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((p) => typeof p?.stars === "number" && p.stars > 0 && typeof p?.relic === "number" && p.relic > 0)
      ) {
        return parsed;
      }
    } catch {
      // fall through to error below
    }
    throw new Error('[env] STARS_PACKAGES is not valid JSON of the form [{"stars":50,"relic":10}, ...]');
  },

  // Admin IDs are optional at this stage of the project (introduced fully in
  // Feature 04). Parsed as an array of Telegram numeric user IDs.
  get ADMIN_IDS(): number[] {
    const raw = optional("ADMIN_IDS");
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n));
  },

  get OWNER_ID(): number | undefined {
    const raw = optional("OWNER_ID");
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) ? n : undefined;
  },

  // Premium Emoji IDs: intentionally OPTIONAL. Missing config must never
  // crash the bot; it must just be easy to notice during development.
  emoji: {
    WORLD: optional("EMOJI_PREMIUM_WORLD"),
    MALE: optional("EMOJI_PREMIUM_MALE"),
    FEMALE: optional("EMOJI_PREMIUM_FEMALE"),
    AGE: optional("EMOJI_PREMIUM_AGE"),
    FLAG_FA: optional("EMOJI_PREMIUM_FLAG_FA"),
    FLAG_EN: optional("EMOJI_PREMIUM_FLAG_EN"),
    FLAG_AR: optional("EMOJI_PREMIUM_FLAG_AR"),
    HOME: optional("EMOJI_PREMIUM_HOME"),
    PERSON: optional("EMOJI_PREMIUM_PERSON"),
    GREEN_CHECK: optional("EMOJI_PREMIUM_GREEN_CHECK"),
    GUIDE: optional("EMOJI_PREMIUM_GUIDE"),
    ANONYMOUS: optional("EMOJI_PREMIUM_ANONYMOUS"),
    LOCATION: optional("EMOJI_PREMIUM_LOCATION"),
    SEARCH: optional("EMOJI_PREMIUM_SEARCH"),
    TIMER: optional("EMOJI_PREMIUM_TIMER"),
    PROFILE: optional("EMOJI_PREMIUM_PROFILE"),
    CROWN: optional("EMOJI_PREMIUM_CROWN"),
    MAILBOX: optional("EMOJI_PREMIUM_MAILBOX"),
    LETTER: optional("EMOJI_PREMIUM_LETTER"),
    INVITE: optional("EMOJI_PREMIUM_INVITE"),
    BACK: optional("EMOJI_PREMIUM_BACK"),
    CHANNEL: optional("EMOJI_PREMIUM_CHANNEL"),
    COURT: optional("EMOJI_PREMIUM_COURT"),
    DICE: optional("EMOJI_PREMIUM_DICE"),
    PEOPLE: optional("EMOJI_PREMIUM_PEOPLE"),
    CONTACT: optional("EMOJI_PREMIUM_CONTACT"),
    LOCK: optional("EMOJI_PREMIUM_LOCK"),
    BOT: optional("EMOJI_PREMIUM_BOT"),
    HEART: optional("EMOJI_PREMIUM_HEART"),
    MESSAGE: optional("EMOJI_PREMIUM_MESSAGE"),
    PLUS: optional("EMOJI_PREMIUM_PLUS"),
    REPORT: optional("EMOJI_PREMIUM_REPORT"),
    NOTIFICATION: optional("EMOJI_PREMIUM_NOTIFICATION"),
    BIOGRAPHY: optional("EMOJI_PREMIUM_BIOGRAPHY"),
    CHAT_STATUS: optional("EMOJI_PREMIUM_CHAT_STATUS"),
    AT_SIGN: optional("EMOJI_PREMIUM_AT_SIGN"),
    SUPPORT: optional("EMOJI_PREMIUM_SUPPORT"),
    LEVEL_NEWCOMER: optional("EMOJI_PREMIUM_LEVEL_NEWCOMER"),
    LEVEL_NORMAL: optional("EMOJI_PREMIUM_LEVEL_NORMAL"),
    LEVEL_ACTIVE: optional("EMOJI_PREMIUM_LEVEL_ACTIVE"),
    LEVEL_PROFESSIONAL: optional("EMOJI_PREMIUM_LEVEL_PROFESSIONAL"),
    LEVEL_SPECIAL: optional("EMOJI_PREMIUM_LEVEL_SPECIAL"),
    LEVEL_LEGEND: optional("EMOJI_PREMIUM_LEVEL_LEGEND"),
    OWNER_BADGE: optional("EMOJI_PREMIUM_OWNER_BADGE"),
    ADMIN_BADGE: optional("EMOJI_PREMIUM_ADMIN_BADGE"),
    VERIFIED_BADGE: optional("EMOJI_PREMIUM_VERIFIED_BADGE"),
    BAN: optional("EMOJI_PREMIUM_BAN"),
    UNBAN: optional("EMOJI_PREMIUM_UNBAN"),
    STATS: optional("EMOJI_PREMIUM_STATS"),
    LOG: optional("EMOJI_PREMIUM_LOG"),
    SETTINGS: optional("EMOJI_PREMIUM_SETTINGS"),
    BROADCAST: optional("EMOJI_PREMIUM_BROADCAST"),
    USERS: optional("EMOJI_PREMIUM_USERS"),
    P1: optional("EMOJI_PREMIUM_1"),
    P2: optional("EMOJI_PREMIUM_2"),
    P3: optional("EMOJI_PREMIUM_3"),
    P4: optional("EMOJI_PREMIUM_4"),
    P5: optional("EMOJI_PREMIUM_5"),
    RESET_USER: optional("EMOJI_PREMIUM_RESET_USER"),
    RELIC: optional("EMOJI_PREMIUM_RELIC"),
    NAVA: optional("EMOJI_PREMIUM_NAVA"),
    VERIFY_REQUEST: optional("EMOJI_PREMIUM_VERIFY_REQUEST"),
    CONTACTS: optional("EMOJI_PREMIUM_CONTACTS"),
    LIKE: optional("EMOJI_PREMIUM_LIKE"),
    INVITE_INTRO: optional("EMOJI_PREMIUM_INVITE_INTRO"),
    INVITE_ANON: optional("EMOJI_PREMIUM_INVITE_ANON"),
    INVITE_FEATURES: optional("EMOJI_PREMIUM_INVITE_FEATURES"),
    INVITE_CTA: optional("EMOJI_PREMIUM_INVITE_CTA"),
    INVITE_LINK: optional("EMOJI_PREMIUM_INVITE_LINK"),
    INVITE_VERIFIED: optional("EMOJI_PREMIUM_INVITE_VERIFIED"),
    INVITE_PROFILE_BONUS: optional("EMOJI_PREMIUM_INVITE_PROFILE_BONUS"),
    INVITE_REFERRAL_BONUS: optional("EMOJI_PREMIUM_INVITE_REFERRAL_BONUS"),
    INVITE_BANNER_READY: optional("EMOJI_PREMIUM_INVITE_BANNER_READY"),
    INVITE_COUNT: optional("EMOJI_PREMIUM_INVITE_COUNT"),
  },
};
