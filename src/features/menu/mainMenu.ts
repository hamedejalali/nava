import { dictionary, requireLocked, type Language } from "../../i18n/index.js";
import { glassButton, inlineKeyboard } from "../../ui/keyboard.js";
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
