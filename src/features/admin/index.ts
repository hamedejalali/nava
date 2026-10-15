import { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { registerAdminPanel } from "./panel.js";
import { registerAdminGuides } from "./guides.js";
import { registerAdminChannels } from "./channels.js";
import { registerAdminRelic } from "./relic.js";
import { registerPostReportsAdmin } from "./postReportsAdmin.js";
import { registerGiftsAdmin } from "./giftsAdmin.js";
import { registerAdminCategories, registerAdminVersionButton } from "./menu.js";

export function registerAdmin(composer: Composer<NavaContext>) {
  registerAdminVersionButton(composer);
  registerAdminCategories(composer);
  registerAdminPanel(composer);
  registerGiftsAdmin(composer);
  registerPostReportsAdmin(composer);
  registerAdminGuides(composer);
  registerAdminChannels(composer);
  registerAdminRelic(composer);
}
