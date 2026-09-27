import type { Context } from "grammy";
import type { UserDoc, Language } from "./db/models/user.js";

export interface NavaContext extends Context {
  /** The user's MongoDB record, attached by middleware before any handler
   *  runs. Undefined only for updates without a `from` user (should not
   *  normally occur for private-chat bot updates). */
  dbUser?: UserDoc;
  /** Convenience accessor for the user's selected language, defaulting to
   *  "fa" only for the pre-selection window (the fixed welcome screen and
   *  its own buttons, which are not driven by this field). */
  userLang: Language;
}
