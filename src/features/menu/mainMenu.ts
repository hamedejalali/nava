import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard, glassReplyButton, replyKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";
import { builtinOverride, customButtons, type BtnStyle } from "../../db/models/uiConfig.js";
import { renderButtonLabel, labelTapForms } from "../../services/emojiSyntax.js";

/** Callback data for each main-menu button. Handlers for these are
 *  intentionally NOT implemented yet — per Feature 04, only the buttons and
 *  navigation structure are created at this stage; behavior is defined in
 *  later prompts. Until then, the bot's generic callback fallback (see
 *  src/bot.ts) safely acknowledges taps without taking any action. */
export const MENU_CALLBACKS = {
  connectAnonymous: "menu:connect_anonymous",
  nearbyPeople: "menu:nearby_people",
  searchUsers: "menu:search_users",
  guide: "menu:guide",
  profile: "menu:profile",
  relicCoin: "menu:relic_coin",
  feedback: "menu:feedback",
  myAnonymousLink: "menu:my_anonymous_link",
  inviteFriends: "menu:invite_friends",
  contacts: "menu:contacts",
} as const;

export function buildMainMenuKeyboard(lang: Language) {
  const t = dictionary(lang);
  const m = t.mainMenu;

  const label = (key: keyof typeof m, path: string) => requireLocked(lang, path, m[key]);

  return inlineKeyboard([
    [glassButton(label("connectAnonymous", "mainMenu.connectAnonymous"), MENU_CALLBACKS.connectAnonymous, "success", buttonIcon("ANONYMOUS"))],
    [
      glassButton(label("nearbyPeople", "mainMenu.nearbyPeople"), MENU_CALLBACKS.nearbyPeople, "primary", buttonIcon("LOCATION")),
      glassButton(label("searchUsers", "mainMenu.searchUsers"), MENU_CALLBACKS.searchUsers, "primary", buttonIcon("SEARCH")),
    ],
    [
      glassButton(label("guide", "mainMenu.guide"), MENU_CALLBACKS.guide, "primary", buttonIcon("GUIDE")),
      glassButton(label("profile", "mainMenu.profile"), MENU_CALLBACKS.profile, "danger", buttonIcon("PROFILE")),
      glassButton(label("relicCoin", "mainMenu.relicCoin"), MENU_CALLBACKS.relicCoin, "primary", buttonIcon("CROWN")),
    ],
    [
      glassButton(label("feedback", "mainMenu.feedback"), MENU_CALLBACKS.feedback, "primary", buttonIcon("MAILBOX")),
      glassButton(label("myAnonymousLink", "mainMenu.myAnonymousLink"), MENU_CALLBACKS.myAnonymousLink, "primary", buttonIcon("LETTER")),
    ],
    [glassButton(label("inviteFriends", "mainMenu.inviteFriends"), MENU_CALLBACKS.inviteFriends, "primary", buttonIcon("INVITE"))],
  ]);
}

/**
 * Persistent, colored Reply Keyboard version of the main menu (per owner
 * request: the main menu must be the bottom docked keyboard, not inline
 * "glass" buttons attached to one message). Reply-keyboard buttons carry no
 * callback_data — a tap arrives as an ordinary text message whose content
 * is exactly the button's label, which `registerMainMenuRouter` below
 * matches back to an action across all 3 supported languages.
 */
/** The owner-designed look of one built-in button (v1.31.0 «طراحی داخلی ربات»): label / colour / hidden, falling back to the defaults. */
function designed(key: MenuAction, label: string, style: "success" | "primary" | "danger", icon: ReturnType<typeof buttonIcon>) {
  const o = builtinOverride(key);
  if (o?.hidden) return null;
  const st: BtnStyle = o?.style ?? style;
  const real = st === "default" ? undefined : st;
  if (o?.label) {
    const r = renderButtonLabel(o.label);
    const nb = glassReplyButton(r.text, real as any, r.iconId);
    if (st === "default") delete (nb as any).style;
    return nb;
  }
  const b = glassReplyButton(label, real as any, icon);
  if (st === "default") delete (b as any).style;
  return b;
}

export function buildMainMenuReplyKeyboard(lang: Language) {
  const t = dictionary(lang);
  const m = t.mainMenu;
  const label = (key: keyof typeof m, path: string) => requireLocked(lang, path, m[key]);
  const B = (key: MenuAction, style: "success" | "primary" | "danger", icon: ReturnType<typeof buttonIcon>) => designed(key, label(key, `mainMenu.${key}`), style, icon);
  const rows = [
    [B("connectAnonymous", "success", buttonIcon("ANONYMOUS"))],
    [B("nearbyPeople", "primary", buttonIcon("LOCATION")), B("contacts", "primary", buttonIcon("CONTACTS")), B("searchUsers", "primary", buttonIcon("SEARCH"))],
    [B("guide", "primary", buttonIcon("GUIDE")), B("profile", "danger", buttonIcon("PROFILE")), B("relicCoin", "primary", buttonIcon("CROWN"))],
    [B("feedback", "primary", buttonIcon("MAILBOX")), B("myAnonymousLink", "primary", buttonIcon("LETTER"))],
    [B("inviteFriends", "primary", buttonIcon("INVITE"))],
  ]
    .map((r) => r.filter((b): b is NonNullable<typeof b> => !!b))
    .filter((r) => r.length > 0);
  // owner-made buttons: two per row, after the built-in ones
  const extra = customButtons().map((c) => {
    const r = renderButtonLabel(c.label ?? "—");
    const b = glassReplyButton(r.text, (c.style === "default" ? undefined : c.style) as any, r.iconId);
    if (c.style === "default") delete (b as any).style;
    return b;
  });
  for (let i = 0; i < extra.length; i += 2) rows.push(extra.slice(i, i + 2));
  return replyKeyboard(rows);
}

type MenuAction = keyof typeof MENU_CALLBACKS;
const LOCALES: Language[] = ["fa", "en", "ar"];

/** text (in ANY supported language) -> which main-menu action it means.
 *  Built once at module load from the same dictionaries the keyboard is
 *  rendered with. Languages whose labels are not supplied yet (en/ar) are
 *  simply skipped — they must never crash the bot or collide with each
 *  other. */
const LABEL_TO_ACTION: Map<string, MenuAction> = (() => {
  const map = new Map<string, MenuAction>();
  for (const lang of LOCALES) {
    const m = dictionary(lang).mainMenu as Record<string, string | undefined>;
    for (const key of Object.keys(MENU_CALLBACKS) as MenuAction[]) {
      const label = m[key];
      if (label) map.set(label, key);
    }
  }
  return map;
})();

/** Drops leading emoji/symbols/spaces, so a tap on "🎭 <label>" (the plain
 *  emoji that replaces a removed premium icon) still matches "<label>". */
function stripLeadingSymbols(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export function matchMainMenuAction(text: string): MenuAction | undefined {
  const base = LABEL_TO_ACTION.get(text) ?? LABEL_TO_ACTION.get(stripLeadingSymbols(text));
  if (base) return base;
  // the owner renamed a built-in button: its new label routes to the same action
  for (const key of Object.keys(MENU_CALLBACKS) as MenuAction[]) {
    const o = builtinOverride(key);
    if (o?.label && !o.hidden && (labelTapForms(o.label).includes(text) || labelTapForms(o.label).includes(stripLeadingSymbols(text)))) return key;
  }
  return undefined;
}

/** A tap on an owner-made button -> the message to send back (raw text, rendered by the caller with the emoji syntax). */
export function matchCustomButton(text: string): { id: string; reply: string } | undefined {
  for (const c of customButtons()) {
    if (c.label && (labelTapForms(c.label).includes(text) || labelTapForms(c.label).includes(stripLeadingSymbols(text)))) return { id: c._id, reply: c.reply ?? "" };
  }
  return undefined;
}
