import { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { registerLanguageHandlers } from "./language.js";
import { registerGenderHandlers } from "./gender.js";
import { registerAgeHandlers } from "./age.js";
import { registerProvinceHandlers } from "./province.js";
import { registerCityHandlers } from "./city.js";
import { registerNicknameHandlers } from "./nickname.js";

export function registerOnboarding(composer: Composer<NavaContext>) {
  registerLanguageHandlers(composer);
  registerGenderHandlers(composer);
  registerAgeHandlers(composer);
  registerProvinceHandlers(composer);
  registerCityHandlers(composer);
  registerNicknameHandlers(composer);
}
