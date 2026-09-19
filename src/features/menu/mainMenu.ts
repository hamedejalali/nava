import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard, glassReplyButton, replyKeyboard } from "../../ui/keyboard.js";
import { buttonIcon } from "../../config/emojis.js";

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
export function buildMainMenuReplyKeyboard(lang: Language) {
  const t = dictionary(lang);
  const m = t.mainMenu;
  const label = (key: keyof typeof m, path: string) => requireLocked(lang, path, m[key]);

  return replyKeyboard([
    [glassReplyButton(label("connectAnonymous", "mainMenu.connectAnonymous"), "success", buttonIcon("ANONYMOUS"))],
    [
      glassReplyButton(label("nearbyPeople", "mainMenu.nearbyPeople"), "primary", buttonIcon("LOCATION")),
      glassReplyButton(label("contacts", "mainMenu.contacts"), "primary", buttonIcon("CONTACTS")),
      glassReplyButton(label("searchUsers", "mainMenu.searchUsers"), "primary", buttonIcon("SEARCH")),
    ],
    [
      glassReplyButton(label("guide", "mainMenu.guide"), "primary", buttonIcon("GUIDE")),
      glassReplyButton(label("profile", "mainMenu.profile"), "danger", buttonIcon("PROFILE")),
      glassReplyButton(label("relicCoin", "mainMenu.relicCoin"), "primary", buttonIcon("CROWN")),
    ],
    [
      glassReplyButton(label("feedback", "mainMenu.feedback"), "primary", buttonIcon("MAILBOX")),
      glassReplyButton(label("myAnonymousLink", "mainMenu.myAnonymousLink"), "primary", buttonIcon("LETTER")),
    ],
    [glassReplyButton(label("inviteFriends", "mainMenu.inviteFriends"), "primary", buttonIcon("INVITE"))],
  ]);
}

type MenuAction = keyof typeof MENU_CALLBACKS;
const LOCALES: Language[] = ["fa", "en", "ar"];

/** text (in ANY supported language) -> which main-menu action it means.
 *  Built once at module load from the same locked i18n strings the
 *  keyboard itself is rendered with, so it can never drift out of sync. */
const LABEL_TO_ACTION: Map<string, MenuAction> = (() => {
  const map = new Map<string, MenuAction>();
  for (const lang of LOCALES) {
    const t = dictionary(lang);
    const m = t.mainMenu;
    for (const key of Object.keys(MENU_CALLBACKS) as MenuAction[]) {
      const label = requireLocked(lang, `mainMenu.${key}`, m[key]);
      map.set(label, key);
    }
  }
  return map;
})();

export function matchMainMenuAction(text: string): MenuAction | undefined {
  return LABEL_TO_ACTION.get(text);
}
