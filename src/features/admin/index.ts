import { Composer } from "grammy";
import type { NavaContext } from "../../bot-context.js";
import { registerAdminPanel } from "./panel.js";
import { registerAdminGuides } from "./guides.js";
import { registerAdminChannels } from "./channels.js";
import { registerAdminRelic } from "./relic.js";

export function registerAdmin(composer: Composer<NavaContext>) {
  registerAdminPanel(composer);
  registerAdminGuides(composer);
  registerAdminChannels(composer);
  registerAdminRelic(composer);
}
